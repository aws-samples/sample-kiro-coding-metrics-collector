import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getGitRepoRoot } from "./utils/git-api";
import { CheckpointStore } from "./attribution/checkpoint-store";
import { KiroLogWatcher } from "./kiro-log-watcher";

export class AIEditManager {
  private workspaceBaseStoragePath: string | null = null;
  private lastHumanCheckpointAt = new Map<string, number>();
  private pendingSaves = new Map<string, {
    timestamp: number;
    timer: NodeJS.Timeout;
  }>();
  private snapshotOpenEvents = new Map<string, {
    timestamp: number;
    count: number;
    uri: vscode.Uri;
  }>();
  private readonly SAVE_EVENT_DEBOUNCE_WINDOW_MS = 1500; // 1.5 秒，等待 Kiro Logs 文件轮询
  private readonly HUMAN_CHECKPOINT_DEBOUNCE_MS = 500;
  private readonly HUMAN_CHECKPOINT_CLEANUP_INTERVAL_MS = 60000; // 1 minute
  private readonly MAX_SNAPSHOT_AGE_MS = 10_000; // 10 seconds; used to avoid triggering AI checkpoints on stale snapshots
  private cleanupTimer: NodeJS.Timeout;
  private stableFileContent = new Map<string, string>();
  private stableContentTimers = new Map<string, NodeJS.Timeout>();
  private readonly STABLE_CONTENT_DEBOUNCE_MS = 2000;

  // Kiro AI 编辑检测：通过监听 Kiro Logs output 文档识别 AI 写文件事件
  // AI 编辑时 Kiro 会写入 "[WriteFile] completed...{filePath}" 日志
  // 人工编辑时不会有此日志
  private kiroAiEditedFiles = new Map<string, number>(); // filePath → timestamp
  private readonly KIRO_AI_EDIT_COOLDOWN_MS = 15_000; // 15 秒内视为 AI 编辑
  private kiroSessionId: string = `kiro-${Date.now()}`; // Kiro agent session ID
  private kiroAgentActive = false; // Kiro agent 是否正在活跃

  // 内置归属追踪（替代 git-ai CLI）
  private checkpointStores = new Map<string, CheckpointStore>();

  // Kiro Logs 文件监听器
  private kiroLogWatcher: KiroLogWatcher;

  constructor(context: vscode.ExtensionContext) {
    if (context.storageUri?.fsPath) {
      this.workspaceBaseStoragePath = path.dirname(context.storageUri.fsPath);
    } else {
      // No workspace active (extension will be re-activated when a workspace is opened)
      console.warn('[kiro-ai-coverage] No workspace storage URI available');
    }

    // Periodically clean up old entries from lastHumanCheckpointAt to avoid memory leaks
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldCheckpointEntries();
    }, this.HUMAN_CHECKPOINT_CLEANUP_INTERVAL_MS);

    // 启动 Kiro Logs 文件监听器
    this.kiroLogWatcher = new KiroLogWatcher();
    this.kiroLogWatcher.start((line) => this.handleKiroLogLine(line));
  }

  public dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.kiroLogWatcher.stop();
    for (const timer of this.stableContentTimers.values()) {
      clearTimeout(timer);
    }
    this.stableContentTimers.clear();
  }

  private cleanupOldCheckpointEntries(): void {
    const now = Date.now();
    const entriesToDelete: string[] = [];

    // Remove entries older than 5 minutes
    const MAX_AGE_MS = 5 * 60 * 1000;

    this.lastHumanCheckpointAt.forEach((timestamp, filePath) => {
      if (now - timestamp > MAX_AGE_MS) {
        entriesToDelete.push(filePath);
      }
    });

    entriesToDelete.forEach(filePath => {
      this.lastHumanCheckpointAt.delete(filePath);
    });

    if (entriesToDelete.length > 0) {
      console.log('[kiro-ai-coverage] AIEditManager: Cleaned up', entriesToDelete.length, 'old checkpoint entries');
    }
  }

  public handleSaveEvent(doc: vscode.TextDocument): void {
    console.log('[kiro-ai-coverage] handleSaveEvent:', doc)
    const filePath = doc.uri.fsPath;

    // Clear any existing timer for this file
    const existing = this.pendingSaves.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
    }

    // Set up new debounce timer
    const timer = setTimeout(() => {
      this.evaluateSaveForCheckpoint(filePath);
    }, this.SAVE_EVENT_DEBOUNCE_WINDOW_MS);

    this.pendingSaves.set(filePath, {
      timestamp: Date.now(),
      timer
    });

    console.log('[kiro-ai-coverage] AIEditManager: Save event tracked for', filePath);
  }

  public handleContentChangeEvent(event: vscode.TextDocumentChangeEvent): void {
    const doc = event.document;

    if (doc.uri.scheme !== "file") {
      return;
    }

    const filePath = doc.uri.fsPath;

    // Clear any existing debounce timer for this file
    const existingTimer = this.stableContentTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // After a quiet period, update the stable content cache
    const timer = setTimeout(() => {
      this.stableFileContent.set(filePath, doc.getText());
      this.stableContentTimers.delete(filePath);
    }, this.STABLE_CONTENT_DEBOUNCE_MS);

    this.stableContentTimers.set(filePath, timer);
  }

  /**
   * 处理 Kiro Logs 的单行日志（来自文件监听器）
   */
  private handleKiroLogLine(line: string): void {
    // 检测 agent 活跃状态
    if (line.includes("[AgentIterator]")) {
      if (!this.kiroAgentActive) {
        this.kiroAgentActive = true;
        this.kiroSessionId = `kiro-${Date.now()}`;
        console.log('[kiro-ai-coverage] Kiro agent 开始活跃, session:', this.kiroSessionId);
      }
    }

    // 检测文件写入完成 → 精确标记具体文件
    const writeMatch = line.match(/\[(WriteFile|ReplaceInFile|StringReplace|EditFile)\][^\n]*?(\/[^\s\n"']+)/);
    if (writeMatch) {
      const filePath = writeMatch[2].trim();
      this.kiroAiEditedFiles.set(filePath, Date.now());
      console.log('[kiro-ai-coverage] Kiro AI 写入文件:', filePath, '(via', writeMatch[1] + ')');
    }

    // 检测 agent 结束
    if (line.includes("[SupervisedDiffSync]") || line.includes("activeExecution\":false")) {
      if (this.kiroAgentActive) {
        this.kiroAgentActive = false;
        console.log('[kiro-ai-coverage] Kiro agent 结束活跃');
      }
    }
  }

  /**
   * 检查文件是否最近被 Kiro AI 编辑过
   */
  private isKiroAiEdited(filePath: string): boolean {
    const ts = this.kiroAiEditedFiles.get(filePath);
    if (!ts) return false;
    if (Date.now() - ts > this.KIRO_AI_EDIT_COOLDOWN_MS) {
      this.kiroAiEditedFiles.delete(filePath);
      return false;
    }
    return true;
  }

  /** 获取或创建 git 仓库的 CheckpointStore */
  private getCheckpointStore(gitRoot: string): CheckpointStore {
    let store = this.checkpointStores.get(gitRoot);
    if (!store) {
      store = new CheckpointStore(gitRoot);
      this.checkpointStores.set(gitRoot, store);
    }
    return store;
  }

  /**
   * 使用内置归属追踪执行 checkpoint（不依赖 git-ai CLI）
   */
  private executeCheckpointNative(
    kind: "human" | "ai_agent",
    filePaths: string[],
    authorId: string
  ): void {
    // 按 git 仓库分组
    const repoFiles = new Map<string, string[]>();
    for (const fp of filePaths) {
      const gitRoot = this.findGitRoot(fp);
      if (!gitRoot) continue;
      const list = repoFiles.get(gitRoot) || [];
      list.push(fp);
      repoFiles.set(gitRoot, list);
    }

    for (const [gitRoot, files] of repoFiles) {
      try {
        const store = this.getCheckpointStore(gitRoot);
        store.executeCheckpoint(kind, authorId, files);
      } catch (err) {
        console.error(`[kiro-ai-coverage] Native checkpoint failed for ${gitRoot}:`, err);
      }
    }
  }

  /** 从文件路径查找 git 仓库根目录 */
  private findGitRoot(filePath: string): string | null {
    try {
      const root = getGitRepoRoot(vscode.Uri.file(filePath));
      if (root) return root;
    } catch { /* */ }
    let dir = path.dirname(filePath);
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  public handleOpenEvent(doc: vscode.TextDocument): void {
    console.log('[kiro-ai-coverage] AIEditManager: Open event detected for', doc);

    // Initialize stable content cache for file:// documents when first opened
    if (doc.uri.scheme === "file" && !this.stableFileContent.has(doc.uri.fsPath)) {
      this.stableFileContent.set(doc.uri.fsPath, doc.getText());
    }

    if (doc.uri.scheme === "chat-editing-snapshot-text-model" || doc.uri.scheme === "chat-editing-text-model") {
      const filePath = doc.uri.fsPath;
      const now = Date.now();

      const existing = this.snapshotOpenEvents.get(filePath);
      if (existing) {
        existing.count++;
        existing.timestamp = now;
      } else {
        this.snapshotOpenEvents.set(filePath, {
          timestamp: now,
          count: 1,
          uri: doc.uri // TODO Should we just let first writer wins for URI?
        });
      }

      // Trigger human checkpoint when whenever we see a snapshot open (before any changes are made -- debounce logic is handled in the triggerHumanCheckpoint method)
      console.log('[kiro-ai-coverage] AIEditManager: Snapshot open event detected for', filePath, 'scheme:', doc.uri.scheme, 'seen count:', this.snapshotOpenEvents.get(filePath)?.count, '- triggering human checkpoint');
      this.triggerHumanCheckpoint([filePath]);
    }
  }

  public handleCloseEvent(doc: vscode.TextDocument): void {
    console.log('[kiro-ai-coverage] handleCloseEvent:', doc)
    // Clean up stable content cache for closed file:// documents
    if (doc.uri.scheme === "file") {
      const filePath = doc.uri.fsPath;
      this.stableFileContent.delete(filePath);
      const timer = this.stableContentTimers.get(filePath);
      if (timer) {
        clearTimeout(timer);
        this.stableContentTimers.delete(filePath);
      }
    }

    if (doc.uri.scheme === "chat-editing-snapshot-text-model" || doc.uri.scheme === "chat-editing-text-model") {
      console.log('[kiro-ai-coverage] AIEditManager: Snapshot close event detected for', doc);
      // console.log('[kiro-ai-coverage] AIEditManager: Snapshot close event detected, triggering human checkpoint');
      // const filePath = doc.uri.fsPath;
      // this.triggerHumanCheckpoint([filePath]);
    }
  }

  public getDirtyFiles(): { [filePath: string]: string } {
    // Return a map of absolute file paths to string content of any dirty files in the workspace
    const dirtyFiles = vscode.workspace.textDocuments.filter(doc => doc.isDirty && doc.uri.scheme === "file");
    return dirtyFiles.reduce((acc, doc) => {
      acc[doc.uri.fsPath] = doc.getText();
      return acc;
    }, {} as { [filePath: string]: string });
  }

  private evaluateSaveForCheckpoint(filePath: string): void {
    const saveInfo = this.pendingSaves.get(filePath);
    if (!saveInfo) {
      return;
    }

    const snapshotInfo = this.snapshotOpenEvents.get(filePath);

    console.log('[kiro-ai-coverage] AIEditManager: Evaluating save for checkpoint for', filePath, '- snapshot info:', snapshotInfo);

    // Check if we have 1+ valid snapshot open events within the debounce window
    let checkpointTriggered = false;

    if (snapshotInfo && snapshotInfo.count >= 1 && snapshotInfo.uri?.query) {
      // Check if the snapshot is fresh to avoid triggering AI checkpoints on stale snapshots
      const snapshotAge = Date.now() - snapshotInfo.timestamp;

      if (snapshotAge >= this.MAX_SNAPSHOT_AGE_MS) {
        console.log('[kiro-ai-coverage] AIEditManager: Snapshot is too old (' + Math.round(snapshotAge / 1000) + 's), skipping AI checkpoint for', filePath);
      } else {
        const storagePath = this.workspaceBaseStoragePath;
        if (!storagePath) {
          console.warn('[kiro-ai-coverage] AIEditManager: Missing workspace storage path, skipping AI checkpoint for', filePath);
        } else {
          try {
            const params = JSON.parse(snapshotInfo.uri.query);
            let sessionId = params.chatSessionId || params.sessionId;

            console.log("[kiro-ai-coverage] AIEditManager: Parsed snapshot params:", params);

            // "{"kind":"doc","documentId":"modified-file-entry::1","chatSessionResource":{"$mid":1,"external":"vscode-chat-session://local/MDFmNjJlNmItOTgxMi00OTY0LWI5YTYtYzRmZDBjZTE1ZmEy","path":"/MDFmNjJlNmItOTgxMi00OTY0LWI5YTYtYzRmZDBjZTE1ZmEy","scheme":"vscode-chat-session","authority":"local"}}"
            if (!sessionId && params.chatSessionResource) {
              // VS Code update includes the chatSessionResource object with the sessionId encoded in the path
              console.log("[kiro-ai-coverage] AIEditManager: Detected chatSessionResource, attempting to parse sessionId");
              sessionId = params.chatSessionResource.path ? Buffer.from(params.chatSessionResource.path.slice(1), 'base64').toString('utf-8') : undefined;
              console.log("[kiro-ai-coverage] AIEditManager: Parsed sessionId from chatSessionResource:", sessionId);
            }

            if (!sessionId && params.session && params.session.path && params.session.path.startsWith && params.session.path.startsWith('/')) {
              // VS Code update includes the sessionId encoded as Base64 
              console.log("[kiro-ai-coverage] AIEditManager: Detected session as object, decoding sessionId");
              sessionId = Buffer.from(params.session.path.slice(1), 'base64').toString('utf-8');
              console.log("[kiro-ai-coverage] AIEditManager: Parsed sessionId from Base64:", sessionId);
            }

            if (!sessionId) {
              console.warn('[kiro-ai-coverage] AIEditManager: Snapshot URI missing session id, skipping AI checkpoint for', filePath);
            } else {
              const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
              if (!workspaceFolder) {
                console.warn('[kiro-ai-coverage] AIEditManager: No workspace folder found for', filePath, '- skipping AI checkpoint');
              } else {
              const chatSessionsDir = path.join(storagePath, 'chatSessions');
              const jsonlPath = path.join(chatSessionsDir, `${sessionId}.jsonl`);
              const jsonPath = path.join(chatSessionsDir, `${sessionId}.json`);
              const chatSessionPath = fs.existsSync(jsonlPath) ? jsonlPath : jsonPath;
              console.log('[kiro-ai-coverage] AIEditManager: AI edit detected for', filePath, '- triggering AI checkpoint (sessionId:', sessionId, ', chatSessionPath:', chatSessionPath, ', workspaceFolder:', workspaceFolder.uri.fsPath, ')');
              
              // Get dirty files and ensure the saved file is included with its content from VS Code
              const dirtyFiles = this.getDirtyFiles();
              console.log('[kiro-ai-coverage] AIEditManager: Dirty files:', dirtyFiles);
              
              // Get the content of the saved file from VS Code (not from FS) to handle codespaces lag
              const savedFileDoc = vscode.workspace.textDocuments.find(doc => 
                doc.uri.fsPath === filePath && doc.uri.scheme === "file"
              );
              if (savedFileDoc) {
                dirtyFiles[filePath] = savedFileDoc.getText();
              }
              
              console.log('[kiro-ai-coverage] AIEditManager: Copilot AI edit detected for', filePath, '- triggering native AI checkpoint');
              this.executeCheckpointNative("ai_agent", [filePath], sessionId);
              checkpointTriggered = true;
              }
            }
          } catch (e) {
            console.error('[kiro-ai-coverage] AIEditManager: Unable to trigger AI checkpoint for', filePath, e);
          }
        }
      }
    }

    if (!checkpointTriggered) {
      // Kiro AI 编辑检测：检查文件是否被 Kiro Logs 标记为 AI 编辑
      if (this.isKiroAiEdited(filePath)) {
        console.log('[kiro-ai-coverage] AIEditManager: Kiro AI edit detected for', filePath, '- triggering native AI checkpoint');

        // 使用内置归属追踪（不依赖 git-ai CLI）
        this.executeCheckpointNative("ai_agent", [filePath], this.kiroSessionId);
        checkpointTriggered = true;

        // 清除标记，避免重复触发
        this.kiroAiEditedFiles.delete(filePath);
      }
    }

    if (!checkpointTriggered) {
      // 非 AI 编辑 → 触发 human checkpoint（记录人工修改覆盖 AI 行的情况）
      console.log('[kiro-ai-coverage] AIEditManager: No AI pattern, triggering human checkpoint for', filePath);
      this.executeCheckpointNative("human", [filePath], "human");
    }

    // Cleanup
    this.pendingSaves.delete(filePath);
    this.snapshotOpenEvents.delete(filePath);
  }

  /**
   * Trigger a human checkpoint with debouncing per file.
   * Debounce logic: trigger immediately, but skip files that were already checkpointed within the debounce window.
   */
  private triggerHumanCheckpoint(willEditFilepaths: string[]): void {
    if (!willEditFilepaths || willEditFilepaths.length === 0) {
      console.warn('[kiro-ai-coverage] AIEditManager: Cannot trigger human checkpoint without files');
      return;
    }

    // Filter out files that were recently checkpointed (within debounce window)
    const now = Date.now();
    const filesToCheckpoint = willEditFilepaths.filter(filePath => {
      const lastCheckpoint = this.lastHumanCheckpointAt.get(filePath);
      if (lastCheckpoint && (now - lastCheckpoint) < this.HUMAN_CHECKPOINT_DEBOUNCE_MS) {
        console.log('[kiro-ai-coverage] AIEditManager: Skipping file due to debounce:', filePath);
        return false;
      }
      return true;
    });

    if (filesToCheckpoint.length === 0) {
      console.log('[kiro-ai-coverage] AIEditManager: All files were recently checkpointed, skipping');
      return;
    }

    // Update last checkpoint time for files we're about to checkpoint
    filesToCheckpoint.forEach(filePath => {
      this.lastHumanCheckpointAt.set(filePath, now);
    });

    // Get dirty files
    const dirtyFiles = this.getDirtyFiles();

    // Add the files we're checkpointing to dirtyFiles (even if they're not dirty)
    // Use stable (pre-edit) content cache to avoid capturing AI edits that may already be in the buffer
    filesToCheckpoint.forEach(filePath => {
      const cachedContent = this.stableFileContent.get(filePath);
      if (cachedContent !== undefined) {
        dirtyFiles[filePath] = cachedContent;
      } else {
        const fileDoc = vscode.workspace.textDocuments.find(doc =>
          doc.uri.fsPath === filePath && doc.uri.scheme === "file"
        );
        if (fileDoc) {
          dirtyFiles[filePath] = fileDoc.getText();
        }
      }
    });

    // Find workspace folder
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filesToCheckpoint[0]))
      || vscode.workspace.workspaceFolders?.[0];

    if (!workspaceFolder) {
      console.warn('[kiro-ai-coverage] AIEditManager: No workspace folder found for human checkpoint');
      return;
    }

    console.log('[kiro-ai-coverage] AIEditManager: Triggering human checkpoint for files:', filesToCheckpoint);

    // Prepare hook input for human checkpoint
    const hookInput = JSON.stringify({
      hook_event_name: "before_edit",
      session_id: this.kiroSessionId, // 包含 kiro session ID 以触发 agent-v1 路径
      workspace_folder: workspaceFolder.uri.fsPath,
      will_edit_filepaths: filesToCheckpoint,
      dirty_files: dirtyFiles,
    });

    this.executeCheckpointNative("human", filesToCheckpoint.map(f => 
      path.isAbsolute(f) ? f : path.join(workspaceFolder.uri.fsPath, f)
    ), "human");
  }
}
