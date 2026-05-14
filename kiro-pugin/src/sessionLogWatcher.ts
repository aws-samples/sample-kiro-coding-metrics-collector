/**
 * SessionLogWatcher — real-time monitor for Kiro Execution Log directory changes.
 *
 * Replaces the unreliable Output Channel–based AIEditManager. Uses `fs.watch`
 * to monitor Kiro Agent Dir execution log directories. When a new or updated
 * Execution Log file is detected, it parses the file, extracts accepted AI
 * write actions, and calls `callCheckpointAgentV1` to write the data into
 * git-ai working logs.
 *
 * Checkpoint flow (per file change):
 * 1. Parse execution log → extract WriteActions with actionState === "Accepted"
 * 2. Filter by sessionId (only process logs for current workspace)
 * 3. Send human checkpoint (originalContent as pre-edit baseline)
 * 4. Send AI checkpoint (modifiedContent as post-edit content)
 * 5. Update StatusBar state
 *
 * All errors are caught and logged with `[git-ai-kiro]` prefix — never thrown.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { SessionLogScanner } from "./sessionLogScanner";
import { buildCheckpointPayload } from "./checkpointPayload";
import { callCheckpointAgentV1, getIgnorePatterns, matchesIgnorePattern } from "./checkpoint";
import type { StatusBar } from "./statusBar";
import type { WriteAction } from "./workspacePathEncoder";
import { normalizePath, groupActionsByRepo } from "./repoRouter.js";
import type { RepoInfo } from "./repoRouter.js";
import { findGitRoot, findGitReposInDir } from "./gitUtils";

/** Debounce window for file change events (ms). */
const FILE_CHANGE_DEBOUNCE_MS = 300;

export class SessionLogWatcher implements vscode.Disposable {
  private scanner: SessionLogScanner;
  private statusBar: StatusBar | null = null;
  private watchers: fs.FSWatcher[] = [];
  /** Tracks the last processed file size per path for deduplication. */
  private lastProcessedSize = new Map<string, number>();
  /** Pending debounce timers keyed by file path. */
  private pendingChanges = new Map<string, NodeJS.Timeout>();
  private workspacePath: string;
  private sessionIds: Set<string> = new Set();
  /** Tracks which 414d* directories already have fs.watch set up. */
  private watchedExecLogDirs = new Set<string>();
  /** Resolved Agent Dir path (set during start). */
  private agentDir: string = "";
  /**
   * Tracks actions that have already been checkpointed, keyed by
   * `${filePath}:${emittedAt}`. Prevents duplicate checkpoints when Kiro
   * incrementally appends to the same execution log file.
   * Capped at MAX_CHECKPOINTED_ACTIONS to avoid unbounded growth.
   */
  private checkpointedActions = new Set<string>();
  private static readonly MAX_CHECKPOINTED_ACTIONS = 3000;
  /** Timestamp of last sessionIds refresh, for cooldown. */
  private lastSessionIdRefresh = 0;
  private static readonly SESSION_ID_REFRESH_COOLDOWN_MS = 10_000;
  /** Discovered git repositories in the workspace. */
  repos: RepoInfo[] = [];
  /** Disposable for the git extension onDidOpenRepository subscription. */
  private gitApiDisposable: vscode.Disposable | null = null;

  constructor(workspacePath: string, scanner?: SessionLogScanner) {
    this.workspacePath = workspacePath;
    this.scanner = scanner ?? new SessionLogScanner();
  }

  setStatusBar(statusBar: StatusBar): void {
    this.statusBar = statusBar;
  }

  /**
   * Discover git repositories via VS Code's built-in git extension API.
   * Follows the same pattern as CommitWatcher.start().
   *
   * Falls back to treating workspacePath as the sole repository root
   * if the git extension is unavailable or not yet active.
   */
  initRepoDiscovery(): void {
    const gitExtension = vscode.extensions.getExtension<GitExtensionAPI>("vscode.git");
    if (!gitExtension) {
      console.warn("[git-ai-kiro] vscode.git extension not found, using findGitRoot fallback");
      this.repos = this.discoverReposFallback();
      return;
    }

    const git = gitExtension.isActive
      ? gitExtension.exports.getAPI(1)
      : null;

    if (!git) {
      console.warn(
        "[git-ai-kiro] Git API not active, using findGitRoot fallback"
      );
      this.repos = this.discoverReposFallback();
      return;
    }

    // Map existing repositories to RepoInfo, filtering out invalid repos
    this.repos = git.repositories
      .map((repo) => ({ rootPath: normalizePath(repo.rootUri.fsPath) }))
      .filter((repo) => {
        // 验证是真正的 git repo（有 .git/HEAD）
        try {
          fs.statSync(path.join(repo.rootPath, ".git", "HEAD"));
          return true;
        } catch {
          console.warn(`[git-ai-kiro] Skipping invalid git repo (no .git/HEAD): ${repo.rootPath}`);
          return false;
        }
      });

    // Subscribe to newly opened repositories
    this.gitApiDisposable = git.onDidOpenRepository((repo: GitRepository) => {
      const newRoot = normalizePath(repo.rootUri.fsPath);
      // Avoid duplicates
      if (!this.repos.some((r) => normalizePath(r.rootPath) === newRoot)) {
        this.repos.push({ rootPath: newRoot });
        console.log(
          `[git-ai-kiro] New repository discovered: ${newRoot}, total repos: ${this.repos.length}`
        );
      }
    });

    // If no repos discovered yet, use fallback
    if (this.repos.length === 0) {
      this.repos = this.discoverReposFallback();
    } else {
      console.log(
        `[git-ai-kiro] Repo discovery: found ${this.repos.length} repo(s) via git extension`
      );
    }
  }

  /**
   * Fallback repo discovery: try findGitRoot (workspace is inside a repo),
   * then scan direct subdirectories (workspace is parent of repos).
   */
  private discoverReposFallback(): RepoInfo[] {
    // 1. workspace 本身是 git repo 或其子目录
    const gitRoot = findGitRoot(this.workspacePath);
    if (gitRoot) {
      console.log(`[git-ai-kiro] findGitRoot found: ${gitRoot}`);
      return [{ rootPath: normalizePath(gitRoot) }];
    }

    // 2. workspace 是 git 项目的父目录，扫描子目录
    const subRepos = findGitReposInDir(this.workspacePath);
    if (subRepos.length > 0) {
      console.log(`[git-ai-kiro] Found ${subRepos.length} git repo(s) in workspace subdirectories: ${subRepos.join(", ")}`);
      return subRepos.map((r) => ({ rootPath: normalizePath(r) }));
    }

    // 3. 最终 fallback
    console.warn("[git-ai-kiro] No git repo found, falling back to workspace root");
    return [{ rootPath: normalizePath(this.workspacePath) }];
  }

  /**
   * Start monitoring: resolve Agent Dir, read session IDs, perform initial
   * scan of existing execution logs, then set up fs.watch on execution log
   * directories (including parent directories for new 414d* subdirectories).
   */
  async start(): Promise<void> {
    try {
      // Discover git repositories for repo-aware checkpoint routing
      this.initRepoDiscovery();

      const agentDir = SessionLogScanner.resolveAgentDir();
      this.agentDir = agentDir;

      // Verify Agent Dir exists
      try {
        await fs.promises.access(agentDir);
      } catch {
        console.warn(
          `[git-ai-kiro] Agent Dir does not exist, SessionLogWatcher not starting: ${agentDir}`
        );
        return;
      }

      // Read session IDs for the current workspace
      this.sessionIds = await this.scanner.getWorkspaceSessionIds(
        this.workspacePath
      );
      console.log(
        `[git-ai-kiro] SessionLogWatcher found ${this.sessionIds.size} session ID(s) for workspace`
      );

      // Enumerate top-level directories (workspace hashes) in Agent Dir
      let topLevelEntries: string[];
      try {
        topLevelEntries = await fs.promises.readdir(agentDir);
      } catch (error) {
        console.warn(
          `[git-ai-kiro] Failed to read Agent Dir: ${agentDir}`,
          error
        );
        return;
      }

      for (const topEntry of topLevelEntries) {
        if (topEntry === "workspace-sessions") continue;

        const topPath = path.join(agentDir, topEntry);

        let topStat: fs.Stats;
        try {
          topStat = await fs.promises.stat(topPath);
        } catch {
          continue;
        }
        if (!topStat.isDirectory()) continue;

        // Watch the workspace-hash directory itself so we catch new 414d*
        // subdirectories created after startup.
        this.watchParentDir(topPath);

        // Look for existing 414d* subdirectories (execution log directories)
        let subEntries: string[];
        try {
          subEntries = await fs.promises.readdir(topPath);
        } catch {
          continue;
        }

        for (const subEntry of subEntries) {
          if (!subEntry.startsWith("414d")) continue;

          const subPath = path.join(topPath, subEntry);

          let subStat: fs.Stats;
          try {
            subStat = await fs.promises.stat(subPath);
          } catch {
            continue;
          }
          if (!subStat.isDirectory()) continue;

          // Set up fs.watch on this execution log directory
          this.watchExecLogDir(subPath);

          // Record existing file sizes so fs.watch only processes new/changed files
          await this.snapshotExistingFiles(subPath);
        }
      }

      console.log(
        `[git-ai-kiro] SessionLogWatcher started with ${this.watchers.length} watcher(s)`
      );
    } catch (error) {
      console.error(
        `[git-ai-kiro] SessionLogWatcher.start() failed:`,
        error
      );
    }
  }

  /**
   * Watch a workspace-hash parent directory for new 414d* subdirectories.
   * When a new 414d* directory appears, set up fs.watch on it and do an
   * initial scan.
   */
  private watchParentDir(parentPath: string): void {
    try {
      const watcher = fs.watch(parentPath, (eventType, filename) => {
        if (!filename || !filename.startsWith("414d")) return;

        const subPath = path.join(parentPath, filename);

        // Debounce: use the subPath as key to avoid duplicate setup
        if (this.watchedExecLogDirs.has(subPath)) return;

        // Delay slightly to let the directory be fully created
        setTimeout(async () => {
          try {
            const stat = await fs.promises.stat(subPath);
            if (!stat.isDirectory()) return;

            if (this.watchedExecLogDirs.has(subPath)) return;

            console.log(
              `[git-ai-kiro] New execution log directory detected: ${subPath}`
            );
            this.watchExecLogDir(subPath);
            await this.snapshotExistingFiles(subPath);
          } catch {
            // Directory may not exist yet or was transient
          }
        }, 200);
      });

      watcher.on("error", (error) => {
        console.warn(
          `[git-ai-kiro] fs.watch error on parent dir ${parentPath}:`,
          error
        );
      });

      this.watchers.push(watcher);
    } catch (error) {
      console.warn(
        `[git-ai-kiro] Failed to watch parent dir ${parentPath}:`,
        error
      );
    }
  }

  /**
   * Set up fs.watch on a single 414d* execution log directory.
   */
  private watchExecLogDir(dirPath: string): void {
    if (this.watchedExecLogDirs.has(dirPath)) return;

    try {
      const watcher = fs.watch(dirPath, (eventType, filename) => {
        this.handleFileChange(dirPath, eventType, filename);
      });

      watcher.on("error", (error) => {
        console.warn(
          `[git-ai-kiro] fs.watch error on ${dirPath}:`,
          error
        );
      });

      this.watchers.push(watcher);
      this.watchedExecLogDirs.add(dirPath);
      console.log(
        `[git-ai-kiro] Watching execution log directory: ${dirPath}`
      );
    } catch (error) {
      console.warn(
        `[git-ai-kiro] Failed to set up fs.watch on ${dirPath}:`,
        error
      );
    }
  }

  /**
   * Snapshot existing files: record file sizes of all existing execution log
   * files so that fs.watch only triggers processing for NEW or CHANGED files.
   *
   * We deliberately do NOT process existing files — the watcher only cares
   * about changes that happen after it starts. This avoids replaying old
   * execution logs that would pollute the working logs.
   */
  private async snapshotExistingFiles(dirPath: string): Promise<void> {
    try {
      const files = await fs.promises.readdir(dirPath);
      let recorded = 0;

      for (const file of files) {
        const filePath = path.join(dirPath, file);

        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          continue;
        }

        if (!stat.isFile()) continue;

        this.lastProcessedSize.set(filePath, stat.size);
        recorded++;
      }

      console.log(
        `[git-ai-kiro] Snapshot: recorded ${recorded} existing files in ${path.basename(dirPath)}`
      );
    } catch (error) {
      console.warn(
        `[git-ai-kiro] Snapshot failed for ${dirPath}:`,
        error
      );
    }
  }

  /**
   * Handle a file change event from fs.watch with debounce.
   *
   * Debounces by 300ms per file path to handle Kiro writing to the same
   * file in multiple passes. After debounce, checks file size for
   * deduplication before processing.
   *
   * Note: Kiro execution log files are named by hash WITHOUT a .json extension,
   * so we accept all filenames (not just *.json).
   */
  private handleFileChange(
    dir: string,
    eventType: string,
    filename: string | null
  ): void {
    if (!filename) return;

    const filePath = path.join(dir, filename);

    // Clear any existing debounce timer for this file
    const existingTimer = this.pendingChanges.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set a new debounce timer
    const timer = setTimeout(() => {
      this.pendingChanges.delete(filePath);
      this.checkAndProcess(filePath);
    }, FILE_CHANGE_DEBOUNCE_MS);

    this.pendingChanges.set(filePath, timer);
  }

  /**
   * Check file size for deduplication, then process if changed.
   */
  private async checkAndProcess(filePath: string): Promise<void> {
    try {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        // File may have been deleted between event and processing
        return;
      }

      // Deduplication: skip if file size hasn't changed since last processing
      const lastSize = this.lastProcessedSize.get(filePath);
      if (lastSize !== undefined && lastSize === stat.size) {
        return;
      }

      console.log(
        `[git-ai-kiro] File changed: ${path.basename(filePath)}, ` +
        `size: ${lastSize ?? "new"} → ${stat.size}`
      );

      // Update tracked size before processing
      this.lastProcessedSize.set(filePath, stat.size);

      await this.processExecutionLog(filePath);
    } catch (error) {
      console.error(
        `[git-ai-kiro] Error checking/processing file: ${filePath}`,
        error
      );
    }
  }

  /**
   * Parse an execution log file, filter by session ID, build payloads,
   * and call callCheckpointAgentV1 for both human and AI checkpoints.
   */
  private async processExecutionLog(filePath: string): Promise<void> {
    try {
      // Parse the execution log file
      const parseResult = await this.scanner.parseExecutionLogFile(filePath);
      if (!parseResult) {
        console.log(
          `[git-ai-kiro] Skipped (parse returned null): ${path.basename(filePath)}`
        );
        return;
      }

      console.log(
        `[git-ai-kiro] Parsed ${path.basename(filePath)}: format=${parseResult.format}, ` +
        `actions=${parseResult.writeActions.length}, sessionId=${parseResult.chatSessionId ?? "none"}, ` +
        `endTime=${parseResult.endTime ?? "none"}`
      );

      // Filter by session ID: only process logs for the current workspace.
      // If mismatch, try refreshing sessions.json once (Kiro may have created
      // a new chat session, e.g., spec workflow).
      if (this.sessionIds.size > 0 && parseResult.chatSessionId !== undefined) {
        if (!this.sessionIds.has(parseResult.chatSessionId)) {
          // Try refreshing session IDs (with cooldown)
          const now = Date.now();
          if (now - this.lastSessionIdRefresh > SessionLogWatcher.SESSION_ID_REFRESH_COOLDOWN_MS) {
            this.lastSessionIdRefresh = now;
            const refreshed = await this.scanner.getWorkspaceSessionIds(this.workspacePath);
            if (refreshed.size > this.sessionIds.size) {
              console.log(
                `[git-ai-kiro] Refreshed session IDs: ${this.sessionIds.size} → ${refreshed.size}`
              );
              this.sessionIds = refreshed;
            }
          }

          // Check again after refresh
          if (!this.sessionIds.has(parseResult.chatSessionId)) {
            console.log(
              `[git-ai-kiro] Skipped (sessionId mismatch): ${path.basename(filePath)}, ` +
              `log=${parseResult.chatSessionId}, ` +
              `workspace=[${[...this.sessionIds].join(", ")}]`
            );
            return;
          }
        }
      } else if (parseResult.chatSessionId === undefined) {
        console.log(
          `[git-ai-kiro] Skipped (no chatSessionId): ${path.basename(filePath)}`
        );
        return;
      }

      const writeActions = parseResult.writeActions;
      if (writeActions.length === 0) return;

      // 基于全部 writeActions 计算 AI 净删除行数（在 checkpointedActions 过滤之前）
      // 需要先按 repo 分组并转换路径，然后计算每个文件的净删除
      {
        const ignPats = getIgnorePatterns();
        // 按 repo 分组（复用 groupActionsByRepo 逻辑）
        const { groups: delGroups } = groupActionsByRepo(writeActions, this.repos, this.workspacePath);
        for (const group of delGroups) {
          const allEarliest = new Map<string, WriteAction>();
          const allLatest = new Map<string, WriteAction>();
          for (const wa of group.actions) {
            const existing = allLatest.get(wa.filePath);
            if (!existing) {
              allEarliest.set(wa.filePath, wa);
              allLatest.set(wa.filePath, wa);
            } else {
              const et = existing.emittedAt ?? 0;
              const ct = wa.emittedAt ?? 0;
              if (ct >= et) allLatest.set(wa.filePath, wa);
              const ear = allEarliest.get(wa.filePath)!;
              if (ct < (ear.emittedAt ?? 0)) allEarliest.set(wa.filePath, wa);
            }
          }
          let aiNetDel = 0;
          for (const [fp, latest] of allLatest) {
            if (ignPats.length > 0 && matchesIgnorePatternSafe(fp, ignPats)) continue;
            const earliest = allEarliest.get(fp);
            let orig = earliest?.originalContent;
            const mod = latest.modifiedContent;
            const isDeleteAction = latest.actionType === "delete";

            // 删除文件场景：originalContent 可能缺失，从 git HEAD 读取原始内容
            if (isDeleteAction && (orig === undefined || orig === "")) {
              try {
                const { execFileSync } = require("node:child_process");
                const gitOutput = execFileSync("git", ["show", `HEAD:${fp}`], {
                  cwd: group.repoPath,
                  encoding: "utf-8",
                  timeout: 5000,
                  stdio: ["ignore", "pipe", "pipe"],
                });
                orig = gitOutput;
              } catch {
                // 文件不在 git 中（新建后又删除），跳过
                continue;
              }
            }

            // 需要 originalContent 才能计算删除行数
            if (orig === undefined) continue;

            // modifiedContent 为 undefined 或 delete 操作时，视为空文件
            const effectiveMod = isDeleteAction ? "" : (mod ?? "");
            const origLines = orig.replace(/\r\n/g, "\n").split("\n");
            let modLines: string[];
            // Windows: originalContent === modifiedContent 时，从磁盘读取实际文件内容
            if (!isDeleteAction && orig === effectiveMod && effectiveMod !== "" && fp) {
              try {
                const absPath = path.resolve(group.repoPath, fp);
                const diskContent = fs.readFileSync(absPath, "utf-8");
                modLines = diskContent.replace(/\r\n/g, "\n").split("\n");
              } catch {
                modLines = [];
              }
            } else {
              modLines = effectiveMod === "" ? [] : effectiveMod.replace(/\r\n/g, "\n").split("\n");
            }
            // 计算实际删除行数：使用简单的贪心顺序匹配（近似 LCS）
            // deletions = origLines.length - matched
            let matched = 0;
            let oi = 0;
            for (let mi = 0; mi < modLines.length && oi < origLines.length; mi++) {
              for (let k = oi; k < origLines.length; k++) {
                if (origLines[k] === modLines[mi]) {
                  matched++;
                  oi = k + 1;
                  break;
                }
              }
            }
            const deletions = origLines.length - matched;
            if (deletions > 0) aiNetDel += deletions;
          }
          if (aiNetDel > 0) {
            try {
              const aiDir = path.join(group.repoPath, ".git", "ai");
              if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir, { recursive: true });
              const netDelFile = path.join(aiDir, "kiro_net_deletions");
              fs.writeFileSync(netDelFile, String(aiNetDel), "utf-8");
              console.log(`[git-ai-kiro] AI net deletions: ${aiNetDel} written to ${netDelFile}`);
            } catch (err) {
              console.warn(`[git-ai-kiro] Failed to write kiro_net_deletions: ${err}`);
            }
          }
        }
      }

      console.log(
        `[git-ai-kiro] Processing ${writeActions.length} write action(s) from: ${filePath}`
      );

      // Log each WriteAction detail
      for (const wa of writeActions) {
        const origLen = wa.originalContent?.length ?? -1;
        const modLen = wa.modifiedContent?.length ?? -1;
        const origLines = wa.originalContent?.split("\n").length ?? 0;
        const modLines = wa.modifiedContent?.split("\n").length ?? 0;
        console.log(
          `[git-ai-kiro]   action: ${wa.actionType}, file: ${wa.filePath}, ` +
          `original: ${origLen} chars / ${origLines} lines, ` +
          `modified: ${modLen} chars / ${modLines} lines, ` +
          `emittedAt: ${wa.emittedAt ?? "none"}`
        );
      }

      // Filter out actions that have already been checkpointed.
      // Kiro incrementally appends actions to the same execution log file,
      // so each file change event may re-read previously seen actions.
      const newActions = writeActions.filter((wa) => {
        const key = `${wa.filePath}:${wa.emittedAt ?? "none"}`;
        return !this.checkpointedActions.has(key);
      });

      if (newActions.length === 0) {
        console.log(
          `[git-ai-kiro] Skipped (all ${writeActions.length} actions already checkpointed): ${path.basename(filePath)}`
        );
        return;
      }

      if (newActions.length < writeActions.length) {
        console.log(
          `[git-ai-kiro] Filtered: ${writeActions.length} total → ${newActions.length} new action(s)`
        );
      }

      const ignorePatterns = getIgnorePatterns();

      // Group actions by repository for per-repo dispatch
      // First, filter actions to only include files under the current workspace
      const workspacePrefix = normalizePath(this.workspacePath).toLowerCase();
      const workspaceFilteredActions = newActions.map((action) => {
        let fp = action.filePath;
        // 如果 filePath 是绝对路径，转为 workspace-relative
        const normalizedFp = normalizePath(fp);
        const wsNorm = normalizePath(this.workspacePath);
        if (normalizedFp.toLowerCase().startsWith(wsNorm.toLowerCase() + "/") || normalizedFp.toLowerCase().startsWith(wsNorm.toLowerCase() + "\\")) {
          fp = normalizedFp.slice(wsNorm.length + 1);
        } else if (path.isAbsolute(fp)) {
          // 绝对路径但不在 workspace 下，尝试匹配 repo
          for (const repo of this.repos) {
            const repoNorm = normalizePath(repo.rootPath);
            if (normalizedFp.toLowerCase().startsWith(repoNorm.toLowerCase() + "/") || normalizedFp.toLowerCase().startsWith(repoNorm.toLowerCase() + "\\")) {
              // 转为 workspace-relative: 先算 repo 相对于 workspace 的路径
              const repoRelToWs = normalizePath(path.relative(this.workspacePath, repo.rootPath));
              const fileRelToRepo = normalizedFp.slice(repoNorm.length + 1);
              fp = repoRelToWs + "/" + fileRelToRepo;
              break;
            }
          }
        }
        return { ...action, filePath: fp };
      }).filter((action) => {
        const absPath = normalizePath(path.resolve(this.workspacePath, action.filePath)).toLowerCase();
        if (!absPath.startsWith(workspacePrefix)) {
          // 多根 workspace 兼容：文件可能在其他 workspace folder 或已发现的 repo 中
          // 检查是否在任何已发现的 repo 下
          const inRepo = this.repos.some((repo) => {
            const repoPrefix = normalizePath(repo.rootPath).toLowerCase();
            return absPath.startsWith(repoPrefix + "/") || absPath.startsWith(repoPrefix + "\\") || absPath === repoPrefix;
          });
          if (!inRepo) {
            // 再检查是否在其他 workspace folders 下
            let inOtherFolder = false;
            try {
              const vsc = require("vscode");
              const folders = vsc.workspace?.workspaceFolders;
              if (folders) {
                for (const f of folders) {
                  const folderPrefix = normalizePath(f.uri.fsPath).toLowerCase();
                  if (absPath.startsWith(folderPrefix + "/") || absPath.startsWith(folderPrefix + "\\")) {
                    inOtherFolder = true;
                    break;
                  }
                }
              }
            } catch { /* vscode not available */ }
            if (!inOtherFolder) {
              console.log(`[git-ai-kiro] Skipping file outside workspace: ${action.filePath} (abs: ${absPath}, ws: ${workspacePrefix})`);
              return false;
            }
          }
        }
        return true;
      });

      if (workspaceFilteredActions.length === 0) {
        console.log(`[git-ai-kiro] Skipped (no files in current workspace after filtering): ${path.basename(filePath)}`);
        return;
      }

      const { groups, orphans } = groupActionsByRepo(
        workspaceFilteredActions,
        this.repos,
        this.workspacePath
      );

      // Log orphan files (actions that don't match any discovered repo)
      // 对于 orphan 文件，尝试动态发现其所属的 git repo 并重新路由
      if (orphans.length > 0) {
        const newReposDiscovered: RepoInfo[] = [];
        for (const orphan of orphans) {
          const absPath = normalizePath(path.resolve(this.workspacePath, orphan.filePath));
          const dirPath = path.dirname(absPath);
          const gitRoot = findGitRoot(dirPath);
          if (gitRoot) {
            const normalizedRoot = normalizePath(gitRoot);
            // 避免重复添加
            if (!this.repos.some((r) => normalizePath(r.rootPath).toLowerCase() === normalizedRoot.toLowerCase())) {
              this.repos.push({ rootPath: normalizedRoot });
              newReposDiscovered.push({ rootPath: normalizedRoot });
              console.log(`[git-ai-kiro] Dynamically discovered repo for orphan file: ${normalizedRoot}`);
            }
          } else {
            console.warn(`[git-ai-kiro] Orphan file (no matching repo): ${orphan.filePath}`);
          }
        }
        // 如果发现了新 repo，重新分组
        if (newReposDiscovered.length > 0) {
          const reGrouped = groupActionsByRepo(orphans, this.repos, this.workspacePath);
          for (const g of reGrouped.groups) {
            groups.push(g);
          }
          for (const o of reGrouped.orphans) {
            console.warn(`[git-ai-kiro] Orphan file (no matching repo after re-discovery): ${o.filePath}`);
          }
        }
      }

      // Filter out actions whose files don't actually exist on disk.
      // This prevents cross-workspace contamination when Kiro execution logs
      // from other workspaces are processed (e.g., files from git-ai workspace
      // appearing in kiro-coverage-test workspace).
      for (const group of groups) {
        const before = group.actions.length;
        group.actions = group.actions.filter((action) => {
          const absPath = path.join(group.repoPath, action.filePath);
          // delete 操作：文件已被删除，跳过存在性检查
          if (action.actionType === "delete") {
            return true;
          }
          // 1. File must exist on disk
          try {
            fs.accessSync(absPath);
          } catch {
            // 文件在当前 repo 下不存在。可能是多根 workspace 中，filePath 的第一段
            // 实际上是同级 workspace folder 的名称（如 "test/Main33.java" 中 "test" 是同级目录）。
            // 尝试在其他 workspace folders 和已知 repos 中查找。
            const segments = action.filePath.replace(/\\/g, "/").split("/");
            if (segments.length >= 2) {
              const firstSeg = segments[0];
              // 检查是否有同级目录匹配第一段
              const parentDir = path.dirname(group.repoPath);
              const candidatePath = path.join(parentDir, action.filePath);
              try {
                fs.accessSync(candidatePath);
                // 文件存在于同级目录！找到其 git repo 并重新路由
                const candidateGitRoot = findGitRoot(path.dirname(candidatePath));
                if (candidateGitRoot) {
                  const normalizedRoot = normalizePath(candidateGitRoot);
                  if (!this.repos.some((r) => normalizePath(r.rootPath).toLowerCase() === normalizedRoot.toLowerCase())) {
                    this.repos.push({ rootPath: normalizedRoot });
                    console.log(`[git-ai-kiro] Dynamically discovered sibling repo: ${normalizedRoot}`);
                  }
                  // 将此 action 移到正确的 group
                  const repoRelPath = normalizePath(candidatePath).slice(normalizePath(candidateGitRoot).length + 1);
                  let targetGroup = groups.find((g) => normalizePath(g.repoPath).toLowerCase() === normalizedRoot.toLowerCase());
                  if (!targetGroup) {
                    targetGroup = { repoPath: normalizedRoot, actions: [] };
                    groups.push(targetGroup);
                  }
                  targetGroup.actions.push({ ...action, filePath: repoRelPath });
                  console.log(`[git-ai-kiro] Re-routed file to sibling repo: ${action.filePath} → ${normalizedRoot}/${repoRelPath}`);
                }
                return false; // 从当前 group 中移除（已移到正确的 group）
              } catch { /* 同级目录也不存在 */ }
            }
            console.log(`[git-ai-kiro] Skipping non-existent file: ${action.filePath} (resolved: ${absPath})`);
            return false;
          }
          // 2. File must be tracked by git (prevents processing files from other repos
          //    that happen to exist at the same relative path)
          try {
            const { execFileSync } = require("node:child_process");
            execFileSync("git", ["ls-files", "--error-unmatch", action.filePath], {
              cwd: group.repoPath,
              timeout: 5000,
              stdio: "pipe",
            });
            return true;
          } catch {
            // File exists but is not tracked by git — could be from another workspace
            // Still allow it (it might be a new file about to be committed)
            return true;
          }
        });
        if (group.actions.length < before) {
          console.log(`[git-ai-kiro] Filtered non-existent files: ${before} → ${group.actions.length} for repo ${group.repoPath}`);
        }
      }

      // Remove empty groups after filtering
      const validGroups = groups.filter(g => g.actions.length > 0);

      if (validGroups.length === 0) {
        console.log(
          `[git-ai-kiro] Skipped (no repo groups after grouping): ${path.basename(filePath)}`
        );
        return;
      }

      // Update StatusBar to checkpointing
      this.statusBar?.setState("checkpointing");

      let anySuccess = false;
      let anyFailure = false;

      // Dispatch per-repo: human + AI checkpoint pair for each repo
      for (const group of validGroups) {
        const { repoPath, actions: repoActions } = group;

        try {
          // Step 1: Send human checkpoint (originalContent as pre-edit baseline)
          const humanPayload = this.buildHumanPayload(
            repoActions,
            parseResult.chatSessionId,
            ignorePatterns,
            repoPath
          );

          if (humanPayload) {
            console.log(
              `[git-ai-kiro] Sending human checkpoint for repo ${repoPath}: ${JSON.stringify({
                type: (humanPayload as Record<string, unknown>).type,
                files: Object.keys((humanPayload as Record<string, unknown>).dirty_files as object),
              })}`
            );
            const humanOk = await callCheckpointAgentV1(
              repoPath,
              humanPayload
            );
            if (!humanOk) {
              console.error(
                `[git-ai-kiro] Human checkpoint failed for repo ${repoPath}: ${filePath}`
              );
            }
          }

          // Step 2: Send AI checkpoint (modifiedContent as post-edit content)
          const aiPayload = await buildCheckpointPayload(
            repoPath,
            repoActions,
            parseResult.chatSessionId,
            ignorePatterns
          );

          // Override dirty_files to use modifiedContent (buildCheckpointPayload
          // uses originalContent by default for Format A)
          const aiDirtyFiles: Record<string, string> = {};
          const latestByFile = new Map<string, WriteAction>();
          for (const action of repoActions) {
            const existing = latestByFile.get(action.filePath);
            if (!existing) {
              latestByFile.set(action.filePath, action);
            } else {
              const existingTime = existing.emittedAt ?? 0;
              const currentTime = action.emittedAt ?? 0;
              if (currentTime >= existingTime) {
                latestByFile.set(action.filePath, action);
              }
            }
          }

          for (const [fp, action] of latestByFile) {
            if (
              ignorePatterns.length > 0 &&
              matchesIgnorePatternSafe(fp, ignorePatterns)
            ) {
              continue;
            }
            if (action.modifiedContent !== undefined) {
              // If modifiedContent equals originalContent, the execution log content
              // is unreliable (Windows issue). Read actual file from disk instead.
              if (action.originalContent !== undefined && action.originalContent === action.modifiedContent) {
                try {
                  const absPath = path.resolve(repoPath, fp);
                  const diskContent = fs.readFileSync(absPath, "utf-8");
                  aiDirtyFiles[fp] = diskContent.replace(/\r\n/g, "\n");
                  console.log(`[git-ai-kiro] AI dirty_files: read from disk for ${fp} (original === modified)`);
                } catch {
                  aiDirtyFiles[fp] = action.modifiedContent.replace(/\r\n/g, "\n");
                }
              } else {
                aiDirtyFiles[fp] = action.modifiedContent.replace(/\r\n/g, "\n");
              }
            }
          }

          const finalAiPayload = {
            ...aiPayload,
            dirty_files: aiDirtyFiles,
          };

          console.log(
            `[git-ai-kiro] Sending AI checkpoint for repo ${repoPath}: edited_filepaths=${JSON.stringify(finalAiPayload.edited_filepaths)}, ` +
            `dirty_files keys=${JSON.stringify(Object.keys(finalAiPayload.dirty_files))}`
          );

          const aiOk = await callCheckpointAgentV1(
            repoPath,
            finalAiPayload
          );

          if (aiOk) {
            console.log(
              `[git-ai-kiro] AI checkpoint succeeded for repo ${repoPath}: ${filePath}`
            );
            anySuccess = true;
            // Mark these actions as checkpointed
            for (const wa of repoActions) {
              const key = `${wa.filePath}:${wa.emittedAt ?? "none"}`;
              this.checkpointedActions.add(key);
            }
          } else {
            console.error(
              `[git-ai-kiro] AI checkpoint failed for repo ${repoPath}: ${filePath}`
            );
            anyFailure = true;
          }
        } catch (error) {
          console.error(
            `[git-ai-kiro] Checkpoint error for repo ${repoPath}: ${filePath}`,
            error
          );
          anyFailure = true;
          // Continue processing remaining repos
        }
      }

      // Cap the checkpointed actions set to prevent unbounded growth
      if (this.checkpointedActions.size > SessionLogWatcher.MAX_CHECKPOINTED_ACTIONS) {
        const excess = this.checkpointedActions.size - SessionLogWatcher.MAX_CHECKPOINTED_ACTIONS;
        const iter = this.checkpointedActions.values();
        for (let i = 0; i < excess; i++) {
          this.checkpointedActions.delete(iter.next().value!);
        }
      }

      // Update StatusBar based on overall result
      if (anySuccess && !anyFailure) {
        this.statusBar?.setState("success");
      } else if (anyFailure) {
        this.statusBar?.setState("failure");
      }
    } catch (error) {
      console.error(
        `[git-ai-kiro] processExecutionLog failed for: ${filePath}`,
        error
      );
    }
  }

  /**
   * Build a human checkpoint payload using originalContent as the pre-edit
   * baseline (dirty_files). This establishes the "before AI edit" state.
   *
   * Returns null if no originalContent is available for any action.
   *
   * @param writeActions - WriteActions with repo-relative filePaths
   * @param chatSessionId - Optional chat session ID
   * @param ignorePatterns - Patterns for files to exclude
   * @param repoPath - Absolute path to the repository root (used for repo_working_dir)
   */
  private buildHumanPayload(
    writeActions: WriteAction[],
    chatSessionId: string | undefined,
    ignorePatterns: string[],
    repoPath: string
  ): object | null {
    const dirtyFiles: Record<string, string> = {};
    const editedFilepaths: string[] = [];
    const seen = new Set<string>();

    for (const action of writeActions) {
      if (
        ignorePatterns.length > 0 &&
        matchesIgnorePatternSafe(action.filePath, ignorePatterns)
      ) {
        continue;
      }

      if (!seen.has(action.filePath)) {
        seen.add(action.filePath);
        editedFilepaths.push(action.filePath);
      }

      // Use originalContent as the pre-edit baseline for human checkpoint
      if (action.originalContent !== undefined) {
        // For multiple edits to the same file, use the earliest originalContent
        // (the true pre-edit state)
        if (!(action.filePath in dirtyFiles)) {
          // Normalize \r\n → \n to match git's internal storage format.
          // Without this, Windows line endings cause git-ai to see every line
          // as changed, marking all lines as human.
          dirtyFiles[action.filePath] = action.originalContent.replace(/\r\n/g, "\n");
        }
      }
    }

    // If no originalContent available at all, skip human checkpoint
    if (Object.keys(dirtyFiles).length === 0) {
      return null;
    }

    return {
      type: "human",
      repo_working_dir: repoPath,
      will_edit_filepaths: editedFilepaths,
      dirty_files: dirtyFiles,
    };
  }

  /**
   * Clean up all watchers, timers, and pending changes.
   */
  dispose(): void {
    // Clean up git API subscription
    this.gitApiDisposable?.dispose();
    this.gitApiDisposable = null;
    this.repos = [];

    // Close all fs.watch watchers
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // best-effort cleanup
      }
    }
    this.watchers = [];

    // Clear all pending debounce timers
    for (const timer of this.pendingChanges.values()) {
      clearTimeout(timer);
    }
    this.pendingChanges.clear();

    // Clear tracking state
    this.lastProcessedSize.clear();
    this.sessionIds.clear();
    this.watchedExecLogDirs.clear();
    this.checkpointedActions.clear();

    console.log("[git-ai-kiro] SessionLogWatcher disposed");
  }
}

/**
 * Safe wrapper around matchesIgnorePattern.
 * Catches any errors to maintain silent degradation.
 */
function matchesIgnorePatternSafe(
  filePath: string,
  patterns: string[]
): boolean {
  try {
    return matchesIgnorePattern(filePath, patterns);
  } catch {
    return false;
  }
}

// Minimal type declarations for VS Code's git extension API
// (mirrors commitWatcher.ts declarations)
interface GitExtensionAPI {
  getAPI(version: 1): GitAPI | undefined;
}

interface GitAPI {
  repositories: GitRepository[];
  onDidOpenRepository: (handler: (repo: GitRepository) => void) => vscode.Disposable;
}

interface GitRepository {
  rootUri: vscode.Uri;
}
