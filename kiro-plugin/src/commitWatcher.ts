import * as vscode from "vscode";
import { execFileSync, spawn } from "node:child_process";
import { getGitAiBinary } from "./checkpoint";
import { reportUserLogin } from "./userSync";
import { isPostCommitHookEffective } from "./gitUtils";
import { uploadCommitStats } from "./statsUploader";

/** Timeout in ms for the post-commit child process. */
const POST_COMMIT_TIMEOUT_MS = 30_000;

/**
 * 执行 post-commit 处理：把 working_logs 转换成 authorship Git Notes。
 *
 * 这一步是必须的，不能省。此前这里是空实现，注释称「git-ai stats 会在内部触发
 * 同样的转换」——实测该说法不成立：提交后不跑 post-commit 时不会产生 note，
 * 随后 `git-ai stats` 也不会补建，于是 AI 写的行全部被计成 human_additions。
 *
 * 之前之所以看起来正常，是因为机器上另装了 git-ai 并把 `git` 代理到它，
 * `git commit` 被拦截时顺带完成了转换。一旦那个全局安装被卸载（或机器上从未
 * 装过），链路就断了。插件不应依赖一个外部安装才能工作。
 *
 * 幂等性：git-ai post-commit 在该提交已有 note 时会直接跳过，因此与仍在执行的
 * post-commit hook 并存也不会重复写入。
 *
 * @returns 转换成功返回 true；失败返回 false（调用方仍会继续上报，
 *          缺少归因也比完全不上报好）
 */
export function runPostCommit(
  repoPath: string,
  commitSha: string
): Promise<boolean> {
  const binary = getGitAiBinary();
  if (!binary) {
    console.error("[git-ai-kiro] Cannot run post-commit: bundled binary not found");
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      const child = spawn(binary, ["post-commit", commitSha], {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        console.error(
          `[git-ai-kiro] post-commit timed out after ${POST_COMMIT_TIMEOUT_MS}ms for ${commitSha.slice(0, 8)}`
        );
        done(false);
      }, POST_COMMIT_TIMEOUT_MS);

      child.on("error", (err) => {
        clearTimeout(timer);
        console.error(`[git-ai-kiro] post-commit spawn failed: ${err}`);
        done(false);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          console.log(
            `[git-ai-kiro] post-commit completed for ${commitSha.slice(0, 8)}`
          );
          done(true);
        } else {
          console.error(
            `[git-ai-kiro] post-commit exited with ${code} for ${commitSha.slice(0, 8)}` +
              (stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : "")
          );
          done(false);
        }
      });
    } catch (err) {
      console.error(`[git-ai-kiro] post-commit unexpected error: ${err}`);
      done(false);
    }
  });
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
          await reportUserLogin();
        } catch (err) {
          console.error(`[git-ai-kiro] Failed to report user login: ${err}`);
        }

        // Stats 上传通常由 post-commit hook 负责。但当 core.hooksPath 被全局/系统级
        // 覆盖到我们无法写入的目录时（常见于企业安全工具），git 根本不会执行仓库内的
        // hook —— 此时若不在这里补上传，该仓库的提交统计会全部丢失。
        //
        // 仅在「我们的 hook 不会被执行」时才上传，避免与 hook 重复上报：两条路径的
        // 幂等键虽已对齐，但重复请求没有必要。
        try {
          if (!isPostCommitHookEffective(repoPath)) {
            console.log(
              `[git-ai-kiro] post-commit hook is not effective for ${repoPath} ` +
                `(core.hooksPath override); uploading stats from the extension instead.`
            );
            await uploadCommitStats(repoPath, currentHead);
          }
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
