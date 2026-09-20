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
import { parseFormatCLog } from "./sessionLogParser";
import { buildCheckpointPayload } from "./checkpointPayload";
import { callCheckpointAgentV1, getIgnorePatterns, matchesIgnorePattern } from "./checkpoint";
import type { StatusBar } from "./statusBar";
import type { WriteAction } from "./workspacePathEncoder";
import { normalizePath, groupActionsByRepo } from "./repoRouter.js";
import type { RepoInfo } from "./repoRouter.js";
import { findGitRoot, findGitReposInDir, resolveGitCommonDir } from "./gitUtils";

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
  /** Maximum number of recent execution-log files to process during cold-start scan. */
  private static readonly COLD_START_SCAN_LIMIT = 10;
  /** Time window for cold-start scan: only files modified within this many ms before now are processed. */
  private static readonly COLD_START_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
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
  /** Format C: byte offset tracking per messages.jsonl file. */
  private formatCBytesRead = new Map<string, number>();
  /** Format C: debounce timers for messages.jsonl changes. */
  private formatCPending = new Map<string, NodeJS.Timeout>();
  /** Format C: watched session directories (to avoid duplicate watches). */
  private watchedKiroSessions = new Set<string>();

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

      // Cold-start scan: process recent execution-log files that existed
      // BEFORE the watcher started. Without this, AI edits made before the
      // extension activated (or before sessions.json was ready) never get
      // checkpointed. Bounded by COLD_START_SCAN_LIMIT and COLD_START_WINDOW_MS
      // to avoid blocking startup with stale data.
      this.runColdStartScan().catch((err: unknown) => {
        console.error(`[git-ai-kiro] Cold-start scan failed:`, err);
      });

      // Format C: monitor the Kiro 1.0 session store (~/.kiro/sessions/).
      this.startFormatCMonitoring().catch((err: unknown) => {
        console.error(`[git-ai-kiro] Format C monitoring setup failed:`, err);
      });

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
   * Cold-start scan: process the most recent execution-log files in every
   * watched 414d* directory so that AI edits made BEFORE the watcher started
   * still get checkpointed.
   *
   * Bounded by:
   *   - COLD_START_SCAN_LIMIT files per directory
   *   - COLD_START_WINDOW_MS lookback window (mtime within last 7 days)
   *
   * Files are processed via the regular processExecutionLog path so all
   * existing safeguards (sessionId filter, repo routing, dedupe) still apply.
   */
  private async runColdStartScan(): Promise<void> {
    const dirs = [...this.watchedExecLogDirs];
    if (dirs.length === 0) return;

    const cutoffMs = Date.now() - SessionLogWatcher.COLD_START_WINDOW_MS;
    let totalScanned = 0;
    let totalProcessed = 0;

    for (const dir of dirs) {
      let files: string[];
      try {
        files = await fs.promises.readdir(dir);
      } catch {
        continue;
      }

      // Build [filePath, mtimeMs] pairs filtered by mtime window
      const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const stat = await fs.promises.stat(filePath);
          if (!stat.isFile()) continue;
          if (stat.mtimeMs < cutoffMs) continue;
          candidates.push({ filePath, mtimeMs: stat.mtimeMs });
        } catch {
          // skip unreadable
        }
      }

      // Process most-recent-first, capped at COLD_START_SCAN_LIMIT
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const slice = candidates.slice(0, SessionLogWatcher.COLD_START_SCAN_LIMIT);

      for (const { filePath } of slice) {
        totalScanned++;
        try {
          await this.processExecutionLog(filePath);
          totalProcessed++;
        } catch (err) {
          console.warn(
            `[git-ai-kiro] Cold-start scan: failed to process ${filePath}:`,
            err
          );
        }
      }
    }

    console.log(
      `[git-ai-kiro] Cold-start scan finished: ${totalProcessed}/${totalScanned} file(s) processed across ${dirs.length} dir(s)`
    );
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
          // ── 方案 D - Part C：aiNetDel 也用 git HEAD 作 baseline ───────────
          // 多轮 AI 编辑时，earliest?.originalContent 是上一轮 AI 的产物，
          // 会导致 deletions 只算“本轮相对上一轮的增量删除”。改用 git HEAD
          // 后每次算出的都是“HEAD→latest disk”的累计删除值，覆盖写入
          // kiro_net_deletions 后最后一次即为期望的总量。
          const headBaselineCache = new Map<string, string | null>();
          const readGitHeadBaseline = (fp: string): string | null => {
            if (headBaselineCache.has(fp)) return headBaselineCache.get(fp)!;
            let result: string | null = null;
            try {
              const { execFileSync } = require("node:child_process");
              const gitOutput = execFileSync("git", ["show", `HEAD:${fp}`], {
                cwd: group.repoPath,
                encoding: "utf-8",
                timeout: 5000,
                stdio: ["ignore", "pipe", "pipe"],
              });
              result = gitOutput;
            } catch {
              result = null;
            }
            headBaselineCache.set(fp, result);
            return result;
          };

          let aiNetDel = 0;
          for (const [fp, latest] of allLatest) {
            if (ignPats.length > 0 && matchesIgnorePatternSafe(fp, ignPats)) continue;
            const earliest = allEarliest.get(fp);
            const mod = latest.modifiedContent;
            const isDeleteAction = latest.actionType === "delete";

            // 优先用 git HEAD 作 baseline，多轮 AI 编辑也能正确累计删除。
            // 文件不在 HEAD（新建后又被编辑/删除）时才回退到 originalContent。
            let orig: string | undefined = readGitHeadBaseline(fp) ?? undefined;
            if (orig === undefined) {
              orig = earliest?.originalContent;
            }

            // 需要 baseline 才能计算删除行数
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
              console.log(`[git-ai-kiro] AI net deletions: ${aiNetDel} written to ${netDelFile} (HEAD-baselined, multi-turn safe)`);
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
                  // 将此 action 移到正确的 group（Windows 大小写不敏感匹配）
                  const normalizedCandidate = normalizePath(candidatePath);
                  const normalizedGitRoot = normalizePath(candidateGitRoot);
                  let repoRelPath: string;
                  if (process.platform === "win32") {
                    // Windows: 大小写不敏感前缀匹配
                    const rootWithSlash = normalizedGitRoot.toLowerCase() + "/";
                    if (normalizedCandidate.toLowerCase().startsWith(rootWithSlash)) {
                      repoRelPath = normalizedCandidate.slice(rootWithSlash.length);
                    } else {
                      repoRelPath = normalizedCandidate.slice(normalizedGitRoot.length + 1);
                    }
                  } else {
                    repoRelPath = normalizedCandidate.slice(normalizedGitRoot.length + 1);
                  }
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
   * Start monitoring the new Kiro session directory (~/.kiro/sessions/).
   * Discovers existing sessions for this workspace and watches for new ones.
   */
  private async startFormatCMonitoring(): Promise<void> {
    // Discover existing sessions with messages.jsonl
    const messagesFiles = await this.scanner.discoverWorkspaceSessions(this.workspacePath);

    if (messagesFiles.length > 0) {
      console.log(
        `[git-ai-kiro] Format C: found ${messagesFiles.length} existing session(s) for workspace`
      );
    }

    for (const msgFile of messagesFiles) {
      this.watchMessagesJsonl(msgFile);
    }

    // Also watch the workspace hash directory for new sess_* directories
    const hashDir = await this.scanner.findKiroSessionHashDir(this.workspacePath);
    if (hashDir) {
      this.watchKiroSessionHashDir(hashDir);
    } else {
      // Watch the top-level sessions dir for new workspace hash directories
      const sessionsDir = SessionLogScanner.resolveKiroSessionDir();
      try {
        await fs.promises.access(sessionsDir);
        this.watchKiroSessionsTopDir(sessionsDir);
      } catch {
        console.log(`[git-ai-kiro] Format C: ~/.kiro/sessions/ does not exist yet`);
      }
    }
  }

  /**
   * Watch a single messages.jsonl file for new appended lines.
   * Uses byte-offset tracking to only read incremental data.
   */
  private watchMessagesJsonl(messagesPath: string): void {
    if (this.watchedKiroSessions.has(messagesPath)) return;
    this.watchedKiroSessions.add(messagesPath);

    // Initialize byte offset to current file size (skip existing content on startup
    // unless within cold-start window)
    const initOffset = async () => {
      try {
        const stat = await fs.promises.stat(messagesPath);
        const cutoff = Date.now() - SessionLogWatcher.COLD_START_WINDOW_MS;
        if (stat.mtimeMs >= cutoff) {
          // File recently modified — process from beginning for cold-start
          this.formatCBytesRead.set(messagesPath, 0);
          // Trigger initial processing
          this.processMessagesJsonlIncremental(messagesPath);
        } else {
          // Old file — skip to end
          this.formatCBytesRead.set(messagesPath, stat.size);
        }
      } catch {
        this.formatCBytesRead.set(messagesPath, 0);
      }
    };

    initOffset();

    // Watch the session directory (parent of messages.jsonl) for changes
    const sessDir = path.dirname(messagesPath);
    try {
      const watcher = fs.watch(sessDir, (eventType, filename) => {
        if (filename !== "messages.jsonl") return;
        this.debounceFormatC(messagesPath);
      });

      watcher.on("error", (error) => {
        console.warn(
          `[git-ai-kiro] Format C: fs.watch error on ${sessDir}:`,
          error
        );
      });

      this.watchers.push(watcher);
      console.log(`[git-ai-kiro] Format C: watching ${path.basename(path.dirname(sessDir))}/${path.basename(sessDir)}/messages.jsonl`);
    } catch (error) {
      console.warn(
        `[git-ai-kiro] Format C: failed to watch ${sessDir}:`,
        error
      );
    }
  }

  /**
   * Watch a workspace hash directory for new sess_* subdirectories.
   */
  private watchKiroSessionHashDir(hashDir: string): void {
    try {
      const watcher = fs.watch(hashDir, (eventType, filename) => {
        if (!filename || !filename.startsWith("sess_")) return;

        const sessPath = path.join(hashDir, filename);
        const messagesPath = path.join(sessPath, "messages.jsonl");

        // Delay to let the directory be fully created
        setTimeout(async () => {
          try {
            await fs.promises.access(messagesPath);
            this.watchMessagesJsonl(messagesPath);
          } catch {
            // messages.jsonl not yet created
          }
        }, 500);
      });

      watcher.on("error", (error) => {
        console.warn(
          `[git-ai-kiro] Format C: fs.watch error on hash dir ${hashDir}:`,
          error
        );
      });

      this.watchers.push(watcher);
      console.log(`[git-ai-kiro] Format C: watching hash dir ${path.basename(hashDir)} for new sessions`);
    } catch (error) {
      console.warn(
        `[git-ai-kiro] Format C: failed to watch hash dir ${hashDir}:`,
        error
      );
    }
  }

  /**
   * Watch the top-level ~/.kiro/sessions/ directory for new workspace hash directories.
   */
  private watchKiroSessionsTopDir(sessionsDir: string): void {
    try {
      const watcher = fs.watch(sessionsDir, (eventType, filename) => {
        if (!filename || filename === "cli") return;

        const hashPath = path.join(sessionsDir, filename);

        // Delay and then check if this new directory is relevant
        setTimeout(async () => {
          try {
            const stat = await fs.promises.stat(hashPath);
            if (!stat.isDirectory()) return;

            // Discover sessions in this new hash dir for our workspace
            const normalizedWs = this.workspacePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
            const sessDirs = await fs.promises.readdir(hashPath);

            for (const sessEntry of sessDirs) {
              if (!sessEntry.startsWith("sess_")) continue;
              const sessionJsonPath = path.join(hashPath, sessEntry, "session.json");
              try {
                const content = await fs.promises.readFile(sessionJsonPath, "utf-8");
                const meta = JSON.parse(content) as Record<string, unknown>;
                if (Array.isArray(meta.workspacePaths)) {
                  const matches = meta.workspacePaths.some((wp: unknown) => {
                    if (typeof wp !== "string") return false;
                    return wp.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === normalizedWs;
                  });
                  if (matches) {
                    this.watchKiroSessionHashDir(hashPath);
                    const msgPath = path.join(hashPath, sessEntry, "messages.jsonl");
                    try {
                      await fs.promises.access(msgPath);
                      this.watchMessagesJsonl(msgPath);
                    } catch {
                      // will be picked up when sess dir watcher fires
                    }
                    break;
                  }
                }
              } catch {
                continue;
              }
            }
          } catch {
            // directory may not exist yet
          }
        }, 1000);
      });

      watcher.on("error", (error) => {
        console.warn(
          `[git-ai-kiro] Format C: fs.watch error on sessions dir:`,
          error
        );
      });

      this.watchers.push(watcher);
      console.log(`[git-ai-kiro] Format C: watching top-level sessions dir for new workspaces`);
    } catch (error) {
      console.warn(
        `[git-ai-kiro] Format C: failed to watch sessions dir:`,
        error
      );
    }
  }

  /**
   * Debounce Format C messages.jsonl changes.
   */
  private debounceFormatC(messagesPath: string): void {
    const existing = this.formatCPending.get(messagesPath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.formatCPending.delete(messagesPath);
      this.processMessagesJsonlIncremental(messagesPath);
    }, FILE_CHANGE_DEBOUNCE_MS);

    this.formatCPending.set(messagesPath, timer);
  }

  /**
   * Read new lines from messages.jsonl since last byte offset, parse with
   * Format C parser, and feed resulting WriteActions into the checkpoint pipeline.
   */
  private async processMessagesJsonlIncremental(messagesPath: string): Promise<void> {
    try {
      const stat = await fs.promises.stat(messagesPath);
      const lastOffset = this.formatCBytesRead.get(messagesPath) ?? 0;

      if (stat.size <= lastOffset) return; // No new data

      // Read only the new bytes
      const fd = await fs.promises.open(messagesPath, "r");
      try {
        const newBytes = stat.size - lastOffset;
        const buffer = Buffer.alloc(newBytes);
        await fd.read(buffer, 0, newBytes, lastOffset);

        // Only consume up to the last COMPLETE line, and advance the offset by
        // exactly that much. Kiro appends one JSON object per line and always
        // terminates it with \n, but an fs.watch event can arrive while a long
        // line (e.g. an fs_write carrying a large file body) is still being
        // flushed. Advancing straight to stat.size would skip past that partial
        // line: it fails to parse, gets dropped, and the completed line is never
        // re-read — silently losing the write action.
        //
        // Searching for \n at the byte level is safe: 0x0A never appears inside
        // a multi-byte UTF-8 sequence, so this never splits a character.
        const lastNewline = buffer.lastIndexOf(0x0a);
        if (lastNewline === -1) {
          // No complete line yet — leave the offset untouched and wait for the
          // next event to deliver the rest of the line.
          return;
        }
        const consumed = lastNewline + 1;
        const newContent = buffer.subarray(0, consumed).toString("utf-8");

        // Update offset to the end of the last complete line
        this.formatCBytesRead.set(messagesPath, lastOffset + consumed);

        // Parse Format C
        const parseResult = parseFormatCLog(newContent);
        if (parseResult.writeActions.length === 0) return;

        console.log(
          `[git-ai-kiro] Format C: parsed ${parseResult.writeActions.length} write action(s) from ${path.basename(path.dirname(messagesPath))}`
        );

        // Extract session ID from path for conversation_id
        // Path: .../sess_<uuid>/messages.jsonl → parent dir name is the session ID
        const sessionId = path.basename(path.dirname(messagesPath));

        // Feed into existing checkpoint pipeline (reuse processExecutionLog's
        // downstream logic: path filtering, repo grouping, checkpoint call)
        await this.processFormatCActions(parseResult.writeActions, sessionId);
      } finally {
        await fd.close();
      }
    } catch (error) {
      console.warn(
        `[git-ai-kiro] Format C: error processing ${messagesPath}:`,
        error
      );
    }
  }

  /**
   * Process Format C write actions through the same path filter and checkpoint
   * logic as Format A/B actions (lines 650+ of processExecutionLog).
   */
  private async processFormatCActions(writeActions: WriteAction[], sessionId?: string): Promise<void> {
    // Deduplicate against already-checkpointed actions
    const newActions = writeActions.filter((wa) => {
      const key = `${wa.filePath}:${wa.emittedAt ?? "none"}`;
      return !this.checkpointedActions.has(key);
    });

    if (newActions.length === 0) return;

    const ignorePatterns = getIgnorePatterns();

    // Group actions by repository (same logic as processExecutionLog)
    const workspacePrefix = normalizePath(this.workspacePath).toLowerCase();
    const workspaceFilteredActions = newActions.map((action) => {
      let fp = action.filePath;
      const normalizedFp = normalizePath(fp);
      const wsNorm = normalizePath(this.workspacePath);

      if (normalizedFp.toLowerCase().startsWith(workspacePrefix)) {
        fp = normalizedFp.slice(wsNorm.length).replace(/^\//, "");
      }
      return { ...action, filePath: fp };
    }).filter((action) => {
      // Filter: only keep paths under workspace
      const absPath = normalizePath(path.resolve(this.workspacePath, action.filePath));
      if (!absPath.toLowerCase().startsWith(workspacePrefix)) return false;
      // Apply ignore patterns
      if (ignorePatterns.length > 0 && matchesIgnorePatternSafe(action.filePath, ignorePatterns)) {
        return false;
      }
      return true;
    });

    if (workspaceFilteredActions.length === 0) return;

    console.log(
      `[git-ai-kiro] Format C: processing ${workspaceFilteredActions.length} workspace-filtered action(s)`
    );

    // Group by repo and checkpoint
    const { groups } = groupActionsByRepo(workspaceFilteredActions, this.repos, this.workspacePath);

    for (const group of groups) {
      if (group.actions.length === 0) continue;

      const absoluteRepo = path.isAbsolute(group.repoPath)
        ? group.repoPath
        : path.resolve(this.workspacePath, group.repoPath);

      // Verify the repo really has a git dir before dispatching a checkpoint.
      // NOTE: resolveGitCommonDir always returns a non-empty string (it falls
      // back to `<repo>/.git`), so a truthiness check would never fire — the
      // existence of the resolved path is what actually needs verifying.
      const gitCommonDir = resolveGitCommonDir(absoluteRepo);
      if (!fs.existsSync(gitCommonDir)) {
        console.warn(
          `[git-ai-kiro] Format C: no git dir at ${gitCommonDir} for repo ${absoluteRepo}, skipping`
        );
        continue;
      }

      // Build AI checkpoint payload.
      // buildCheckpointPayload may use originalContent snippets which are not full
      // file content in Format C (str_replace), so we override dirty_files with disk content.
      const payload = await buildCheckpointPayload(absoluteRepo, group.actions, sessionId ?? "kiro-format-c", ignorePatterns);

      // Override dirty_files: read current (post-AI-edit) content from disk
      const aiDirtyFiles: Record<string, string> = {};
      const editedFilePaths = new Set<string>();
      for (const action of group.actions) {
        editedFilePaths.add(action.filePath);
      }
      for (const fp of editedFilePaths) {
        if (ignorePatterns.length > 0 && matchesIgnorePatternSafe(fp, ignorePatterns)) {
          continue;
        }
        try {
          const absPath = path.resolve(absoluteRepo, fp);
          const diskContent = await fs.promises.readFile(absPath, "utf-8");
          aiDirtyFiles[fp] = diskContent.replace(/\r\n/g, "\n");
        } catch {
          console.log(`[git-ai-kiro] Format C: could not read file for dirty_files: ${fp}`);
        }
      }

      const finalPayload = { ...payload, dirty_files: aiDirtyFiles };

      console.log(
        `[git-ai-kiro] Format C: calling checkpoint for repo=${absoluteRepo}, ` +
        `files=${finalPayload.edited_filepaths.length}, dirty_keys=${Object.keys(finalPayload.dirty_files).length}`
      );

      const ok = await callCheckpointAgentV1(absoluteRepo, finalPayload);

      if (ok) {
        // Mark actions as checkpointed
        for (const action of group.actions) {
          const key = `${action.filePath}:${action.emittedAt ?? "none"}`;
          this.checkpointedActions.add(key);
          if (this.checkpointedActions.size > SessionLogWatcher.MAX_CHECKPOINTED_ACTIONS) {
            const first = this.checkpointedActions.values().next().value;
            if (first !== undefined) this.checkpointedActions.delete(first);
          }
        }
        // Update status bar
        if (this.statusBar) {
          this.statusBar.setState("success");
        }
      } else {
        console.error(`[git-ai-kiro] Format C: checkpoint failed for repo ${absoluteRepo}`);
        if (this.statusBar) {
          this.statusBar.setState("failure");
        }
      }
    }
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

    // Same for the Format C debounce timers. Without this, a pending timer can
    // fire after dispose() and drive a checkpoint on a torn-down watcher.
    for (const timer of this.formatCPending.values()) {
      clearTimeout(timer);
    }
    this.formatCPending.clear();
    this.formatCBytesRead.clear();
    this.watchedKiroSessions.clear();

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
