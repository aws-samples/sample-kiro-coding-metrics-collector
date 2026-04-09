/**
 * CommitWatcher - 监听 git commit 事件，触发 stats 上报
 *
 * 通过 VSCode 内置 git 扩展 API 监听 HEAD 变化，
 * 检测到新的本地 commit 后，延迟查询 git-ai stats 并上报。
 */

import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { uploadCommitStats } from "./stats-uploader";

const POST_COMMIT_DELAY_MS = 3_000;

export class CommitWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly uploadedCommits = new Set<string>();
  private lastKnownHead = new Map<string, string>();

  start(): void {
    const gitExtension = vscode.extensions.getExtension<GitExtensionAPI>("vscode.git");
    if (!gitExtension) {
      console.log("[git-ai-kiro] vscode.git extension not found, commit watcher disabled");
      return;
    }

    const git = gitExtension.isActive ? gitExtension.exports.getAPI(1) : null;
    if (!git) {
      console.log("[git-ai-kiro] Git API not available, commit watcher disabled");
      return;
    }

    for (const repo of git.repositories) {
      this.watchRepository(repo);
    }

    const sub = git.onDidOpenRepository((repo: GitRepository) => {
      this.watchRepository(repo);
    });
    this.disposables.push(sub);

    console.log(`[git-ai-kiro] Commit watcher started, watching ${git.repositories.length} repo(s)`);
  }

  private watchRepository(repo: GitRepository): void {
    const repoPath = repo.rootUri.fsPath;

    const initialHead = repo.state.HEAD?.commit;
    let skipFirst = !initialHead;
    if (initialHead) {
      this.lastKnownHead.set(repoPath, initialHead);
      this.uploadedCommits.add(initialHead);
    }

    const sub = repo.state.onDidChange(() => {
      const currentHead = repo.state.HEAD?.commit;
      if (!currentHead) return;

      if (skipFirst) {
        skipFirst = false;
        this.lastKnownHead.set(repoPath, currentHead);
        this.uploadedCommits.add(currentHead);
        return;
      }

      const previousHead = this.lastKnownHead.get(repoPath);
      this.lastKnownHead.set(repoPath, currentHead);

      if (currentHead === previousHead) return;
      if (this.uploadedCommits.has(currentHead)) return;
      this.uploadedCommits.add(currentHead);

      console.log(`[git-ai-kiro] New commit detected: ${currentHead.slice(0, 8)} in ${repoPath}`);

      if (!isLocalCommit(repoPath)) {
        console.log(`[git-ai-kiro] Not a local commit, skipping upload`);
        return;
      }

      setTimeout(() => {
        uploadCommitStats(repoPath, currentHead).catch((err) => {
          console.error(`[git-ai-kiro] Failed to upload commit stats: ${err}`);
        });
      }, POST_COMMIT_DELAY_MS);
    });

    this.disposables.push(sub);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

function isLocalCommit(cwd: string): boolean {
  try {
    const reflogEntry = execFileSync("git", ["reflog", "-1", "--format=%gs"], {
      cwd, timeout: 5_000, encoding: "utf-8",
    }).trim();
    return reflogEntry.startsWith("commit");
  } catch {
    return true;
  }
}

interface GitExtensionAPI {
  getAPI(version: 1): GitAPI | undefined;
}
interface GitAPI {
  repositories: GitRepository[];
  onDidOpenRepository: (handler: (repo: GitRepository) => void) => vscode.Disposable;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
}
interface GitRepositoryState {
  HEAD: { commit?: string } | undefined;
  onDidChange: vscode.Event<void>;
}
