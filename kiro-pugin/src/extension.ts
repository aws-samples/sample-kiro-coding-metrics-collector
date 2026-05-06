import * as path from "node:path";
import * as vscode from "vscode";
import { initBundledBinary, isBinaryReady } from "./checkpoint";
import { CommitWatcher } from "./commitWatcher";
import { findGitRoot, installHooksForWorkspace } from "./gitUtils";
import { SessionLogWatcher } from "./sessionLogWatcher";
import { StatusBar } from "./statusBar";
import { reportUserLogin, stopUserSync } from "./userSync";

/**
 * Determine whether a git.path value should be cleaned up.
 * Returns true if gitPath points inside the extension's bin/ directory.
 * Pure function — no side effects — exported for property testing.
 */
export function shouldCleanupGitPath(extensionPath: string, gitPath: string): boolean {
  const binDir = path.normalize(path.join(extensionPath, "bin"));
  const normalizedGitPath = path.normalize(gitPath);
  return normalizedGitPath.startsWith(binDir + path.sep) || normalizedGitPath === binDir;
}

/**
 * Clean up stale git.path configuration left by previous versions of the extension.
 * Only resets git.path if it points to a path within this extension's bin/ directory.
 */
function cleanupGitPathOverride(extensionPath: string): void {
  try {
    const gitConfig = vscode.workspace.getConfiguration("git");
    const currentGitPath = gitConfig.get<string>("path");
    if (!currentGitPath) {
      return;
    }

    if (shouldCleanupGitPath(extensionPath, currentGitPath)) {
      gitConfig.update("path", undefined, vscode.ConfigurationTarget.Global).then(
        () => console.log(`[git-ai-kiro] Cleaned up stale git.path: ${currentGitPath}`),
        (err) => console.error(`[git-ai-kiro] Failed to reset git.path: ${err}`)
      );
    }
  } catch (err) {
    console.error(`[git-ai-kiro] Error during git.path cleanup: ${err}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log("[git-ai-kiro] Activating extension");
  console.log(`[git-ai-kiro] Extension path: ${context.extensionPath}`);
  console.log(`[git-ai-kiro] Extension mode: ${context.extensionMode}`);
  console.log(`[git-ai-kiro] Platform: ${process.platform} / ${process.arch}`);

  const statusBar = new StatusBar();

  // 上报用户登录信息（异步，不阻塞启动）
  reportUserLogin();

  initBundledBinary(context.extensionPath);
  cleanupGitPathOverride(context.extensionPath);

  if (!isBinaryReady()) {
    statusBar.setState("inactive");
    return;
  }

  statusBar.setState("watching");

  // Install git post-commit hooks for all discovered repos
  installHooksForWorkspace();

  // Get current workspace path — keep as-is for file path resolution.
  // findGitRoot is used internally by sessionLogWatcher for repo discovery,
  // but workspacePath must remain the actual opened directory.
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (workspacePath) {
    // Create SessionLogWatcher (replaces AIEditManager)
    // Monitors Kiro Execution Log directory changes in real-time,
    // writes AI edit data into git-ai working logs on detection.
    const watcher = new SessionLogWatcher(workspacePath);
    watcher.setStatusBar(statusBar);
    watcher.start(); // async start, don't block activate
    context.subscriptions.push(watcher);
  }

  // CommitWatcher remains unchanged: detect commit → runPostCommit → uploadCommitStats
  const commitWatcher = new CommitWatcher();
  commitWatcher.start();
  context.subscriptions.push(statusBar, commitWatcher);
}

export function deactivate() {
  stopUserSync();
  console.log("[git-ai-kiro] Extension deactivated");
}
