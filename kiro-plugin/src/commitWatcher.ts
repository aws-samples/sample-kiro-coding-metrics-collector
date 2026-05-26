import * as vscode from "vscode";
import { execFileSync, spawn } from "node:child_process";
import { getGitAiBinary } from "./checkpoint";
import { reportUserLogin } from "./userSync";

/** Timeout in ms for the post-commit child process. */
const POST_COMMIT_TIMEOUT_MS = 30_000;

/**
 * Invoke the git-ai binary to execute post-commit processing.
 * git-ai doesn't have a direct "post-commit" command — the post-commit
 * logic (working logs → Git Notes) happens automatically when git is
 * proxied through git-ai. For direct invocations, we use `git-ai stats`
 * which triggers the same conversion internally.
 * @returns true always (no-op, stats query handles conversion)
 */
export function runPostCommit(
  _repoPath: string,
  _commitSha: string
): Promise<boolean> {
  // No-op: git-ai stats will handle working_logs → Git Notes conversion
  return Promise.resolve(true);
}

/**
 * Watches for new git commits via VS Code's built-in git extension API.
 * When a new commit is detected (HEAD changes), triggers stats upload.
 */
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

    const git = gitExtension.isActive
      ? gitExtension.exports.getAPI(1)
      : null;

    if (!git) {
      console.log("[git-ai-kiro] Git API not available, commit watcher disabled");
      return;
    }

    // Watch existing repositories
    for (const repo of git.repositories) {
      this.watchRepository(repo);
    }

    // Watch for newly opened repositories
    const sub = git.onDidOpenRepository((repo: GitRepository) => {
      this.watchRepository(repo);
    });
    this.disposables.push(sub);

    console.log(`[git-ai-kiro] Commit watcher started, watching ${git.repositories.length} repo(s)`);
  }

  private watchRepository(repo: GitRepository): void {
    const repoPath = repo.rootUri.fsPath;

    // Record initial HEAD and mark it as already uploaded.
    // If HEAD is not yet available (git extension still initializing),
    // we skip the first onDidChange event to avoid uploading the
    // pre-existing commit on startup.
    const initialHead = repo.state.HEAD?.commit;
    let skipFirst = !initialHead;
    if (initialHead) {
      this.lastKnownHead.set(repoPath, initialHead);
      this.uploadedCommits.add(initialHead);
    }

    const sub = repo.state.onDidChange(() => {
      const currentHead = repo.state.HEAD?.commit;
      if (!currentHead) {
        return;
      }

      // If we didn't have HEAD at startup, skip the first event
      // (it's the git extension finishing initialization, not a new commit).
      if (skipFirst) {
        skipFirst = false;
        this.lastKnownHead.set(repoPath, currentHead);
        this.uploadedCommits.add(currentHead);
        console.log(
          `[git-ai-kiro] Skipping initial HEAD: ${currentHead.slice(0, 8)} in ${repoPath}`
        );
        return;
      }

      const previousHead = this.lastKnownHead.get(repoPath);
      this.lastKnownHead.set(repoPath, currentHead);

      // Only trigger on actual new commits (HEAD changed)
      if (currentHead === previousHead) {
        return;
      }

      // Deduplicate
      if (this.uploadedCommits.has(currentHead)) {
        return;
      }
      this.uploadedCommits.add(currentHead);

      console.log(
        `[git-ai-kiro] New commit detected: ${currentHead.slice(0, 8)} in ${repoPath}`
      );

      // Only upload for local commits (not pulls, merges, checkouts, etc.)
      if (!isLocalCommit(repoPath)) {
        console.log(
          `[git-ai-kiro] HEAD change for ${currentHead.slice(0, 8)} is not a local commit, skipping upload`
        );
        return;
      }

      // Run post-commit processing, then upload stats regardless of outcome.
      (async () => {
        try {
          await runPostCommit(repoPath, currentHead);
        } catch (err) {
          console.error(`[git-ai-kiro] post-commit unexpected error: ${err}`);
        }
        try {
          // 每次 commit 时也上报用户登录信息（更新 IP、活跃时间）
          // Stats 上传由 post-commit hook 负责，避免重复上报
          await reportUserLogin();
        } catch (err) {
          console.error(`[git-ai-kiro] Failed to upload commit stats: ${err}`);
        }
      })();
    });

    this.disposables.push(sub);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    console.log("[git-ai-kiro] Commit watcher disposed");
  }
}

/**
 * Check if the latest HEAD change was caused by a local commit
 * by inspecting the reflog. Local commits produce entries starting
 * with "commit:", while pull/merge/checkout produce different prefixes.
 */
function isLocalCommit(cwd: string): boolean {
  try {
    const reflogEntry = execFileSync(
      "git", ["reflog", "-1", "--format=%gs"],
      { cwd, timeout: 5_000, encoding: "utf-8" }
    ).trim();
    // Local commits: "commit: message" or "commit (amend): message" or "commit (initial): message"
    return reflogEntry.startsWith("commit");
  } catch {
    // If reflog is unavailable, allow the upload
    return true;
  }
}

// Minimal type declarations for VS Code's git extension API
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
