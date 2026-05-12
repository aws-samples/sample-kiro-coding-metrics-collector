/**
 * Git utility functions — finding git root, installing hooks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getGitAiBinary } from "./checkpoint";
import { STATS_URL } from "./apiConfig";

/**
 * Find the git repository root by walking up from the given path.
 * Returns null if no .git directory is found.
 */
export function findGitRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    const gitDir = path.join(current, ".git");
    try {
      const stat = fs.statSync(gitDir);
      if (stat.isDirectory()) {
        // 验证是有效的 git repo（必须有 HEAD 文件）
        try {
          fs.statSync(path.join(gitDir, "HEAD"));
          return current;
        } catch {
          // .git 目录存在但不是有效 git repo，继续向上查找
        }
      }
      // .git can also be a file (worktrees/submodules)
      if (stat.isFile()) {
        return current;
      }
    } catch {
      // .git doesn't exist here, keep walking up
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Scan direct subdirectories of the given path for git repositories.
 * Returns an array of absolute paths to git repo roots found.
 * Only scans one level deep to avoid excessive I/O.
 */
export function findGitReposInDir(dirPath: string): string[] {
  const repos: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const subDir = path.join(dirPath, entry.name);
      const gitDir = path.join(subDir, ".git");
      try {
        const stat = fs.statSync(gitDir);
        if (stat.isDirectory() || stat.isFile()) {
          repos.push(subDir);
        }
      } catch {
        // no .git here
      }
    }
  } catch {
    // can't read directory
  }
  return repos;
}

/**
 * Install a git pre-commit hook that runs a human checkpoint.
 *
 * This captures any human edits made after the last AI checkpoint,
 * so that git-ai can correctly attribute mixed lines (AI-written lines
 * that were later modified by a human).
 *
 * The pre-commit hook runs synchronously before the commit is created,
 * while staged files are still visible to `git status`.
 */
export function installPreCommitHook(repoPath: string): void {
  const binary = getGitAiBinary();
  if (!binary) {
    console.log("[git-ai-kiro] Cannot install pre-commit hook: binary not available");
    return;
  }

  const hooksDir = path.join(repoPath, ".git", "hooks");
  const hookPath = path.join(hooksDir, "pre-commit");
  const marker = "# >>> git-ai-kiro pre-commit hook >>>";
  const endMarker = "# <<< git-ai-kiro pre-commit hook <<<";

  // Ensure hooks directory exists
  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch {
    console.error(`[git-ai-kiro] Cannot create hooks dir: ${hooksDir}`);
    return;
  }

  // Check if hook already has our section — remove old version to update
  let existingContent = "";
  try {
    existingContent = fs.readFileSync(hookPath, "utf-8");
    if (existingContent.includes(marker)) {
      const startIdx = existingContent.indexOf(marker);
      const endIdx = existingContent.indexOf(endMarker);
      if (startIdx >= 0 && endIdx >= 0) {
        existingContent = existingContent.slice(0, startIdx) + existingContent.slice(endIdx + endMarker.length);
        existingContent = existingContent.replace(/\n{3,}/g, "\n\n").trim();
      }
    }
  } catch {
    // File doesn't exist yet
  }

  const binaryEscaped = binary.replace(/\\/g, "/");
  const hookSection = `${marker}
# Auto-installed by git-ai-kiro plugin. Do not edit this section manually.
# Capture human edits before commit so AI/human attribution is correct.
"${binaryEscaped}" checkpoint human 2>/dev/null || true
${endMarker}`;

  let finalContent: string;
  if (existingContent) {
    finalContent = existingContent.trimEnd() + "\n\n" + hookSection + "\n";
  } else {
    finalContent = "#!/bin/sh\n" + hookSection + "\n";
  }

  try {
    fs.writeFileSync(hookPath, finalContent, "utf-8");
    if (os.platform() !== "win32") {
      fs.chmodSync(hookPath, 0o755);
    }
    console.log(`[git-ai-kiro] Installed pre-commit hook in ${repoPath}`);
  } catch (err) {
    console.error(`[git-ai-kiro] Failed to install pre-commit hook: ${err}`);
  }
}

/**
 * Install a git post-commit hook that invokes git-ai post-commit and
 * uploads stats to the dashboard.
 *
 * The hook script:
 * 1. Runs `git-ai post-commit <sha>` to convert working logs to Git Notes
 * 2. Runs `git-ai stats <sha> --json` and POSTs to the dashboard
 *
 * If a post-commit hook already exists, appends the git-ai section
 * (guarded by a marker comment to avoid duplicates).
 */
export function installPostCommitHook(repoPath: string): void {
  const binary = getGitAiBinary();
  if (!binary) {
    console.log("[git-ai-kiro] Cannot install hook: binary not available");
    return;
  }

  const hooksDir = path.join(repoPath, ".git", "hooks");
  const marker = "# >>> git-ai-kiro post-commit hook >>>";
  const endMarker = "# <<< git-ai-kiro post-commit hook <<<";
  const isWindows = os.platform() === "win32";
  const hookPath = path.join(hooksDir, "post-commit");

  // Ensure hooks directory exists
  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch {
    console.error(`[git-ai-kiro] Cannot create hooks dir: ${hooksDir}`);
    return;
  }

  // Check if hook already has our section — remove old version to update
  let existingContent = "";
  try {
    existingContent = fs.readFileSync(hookPath, "utf-8");
    if (existingContent.includes(marker)) {
      const startIdx = existingContent.indexOf(marker);
      const endIdx = existingContent.indexOf(endMarker);
      if (startIdx >= 0 && endIdx >= 0) {
        existingContent = existingContent.slice(0, startIdx) + existingContent.slice(endIdx + endMarker.length);
        existingContent = existingContent.replace(/\n{3,}/g, "\n\n").trim();
      }
    }
  } catch {
    // File doesn't exist yet
  }

  // Choose hook strategy:
  //   - non-Windows: always sh
  //   - Windows: first probe sh.exe (Git Bash). If present, use sh — same as
  //     Unix, no PowerShell needed. Otherwise fall back to the legacy PS1 hook
  //     and surface a warning if ExecutionPolicy blocks the PS1.
  const binaryEscaped = binary.replace(/\\/g, "/");
  const useShHook = !isWindows || canRunShOnWindows();

  let hookSection: string;
  if (useShHook) {
    hookSection = buildHookSectionUnix(binaryEscaped, marker, endMarker);
    // Clean up legacy Windows scripts when switching to sh
    if (isWindows) {
      for (const legacyName of ["git-ai-post-commit.ps1", "git-ai-post-commit.cmd"]) {
        const legacyPath = path.join(hooksDir, legacyName);
        try {
          if (fs.existsSync(legacyPath)) {
            fs.unlinkSync(legacyPath);
            console.log(`[git-ai-kiro] Removed legacy hook script: ${legacyPath}`);
          }
        } catch { /* ignore */ }
      }
    }
  } else {
    // Windows sh unavailable — fall back to PowerShell
    hookSection = buildHookSectionWindows(binaryEscaped, marker, endMarker, hooksDir);
    // Verify PowerShell is actually runnable under the user's ExecutionPolicy.
    // If blocked, surface a one-time warning with the exact fix command.
    if (!canRunPowerShellHere(hooksDir)) {
      notifyPowerShellBlocked();
    }
  }

  let finalContent: string;
  if (existingContent) {
    finalContent = existingContent.trimEnd() + "\n\n" + hookSection + "\n";
  } else {
    finalContent = "#!/bin/sh\n" + hookSection + "\n";
  }

  try {
    fs.writeFileSync(hookPath, finalContent, "utf-8");
    if (!isWindows) {
      fs.chmodSync(hookPath, 0o755);
    }
    console.log(`[git-ai-kiro] Installed post-commit hook in ${repoPath}`);
  } catch (err) {
    console.error(`[git-ai-kiro] Failed to install post-commit hook: ${err}`);
  }
}

function getHookConfig(): { statsUrl: string; ignoreArgs: string } {
  const statsUrl = STATS_URL;
  let ignoreArgs = "";
  try {
    const vscode = require("vscode");
    const config = vscode.workspace.getConfiguration("gitai.kiro");
    const patterns: string[] = config.get("ignorePatterns") ?? [];
    if (patterns.length > 0) {
      const globs = patterns.map((p: string) => {
        if (p.includes("*") || p.includes("/")) return p;
        return `**/${p}/**`;
      });
      ignoreArgs = " --ignore " + globs.map((g: string) => `"${g}"`).join(" ");
    }
  } catch { /* not in VS Code context */ }
  return { statsUrl, ignoreArgs };
}

function buildHookSectionUnix(binaryPath: string, marker: string, endMarker: string): string {
  const { statsUrl, ignoreArgs } = getHookConfig();
  // curl.exe 与 git-ai 在同一个 bin/ 目录下，Windows 上没有系统 curl 时使用插件自带的
  const binDir = binaryPath.replace(/\/[^/]+$/, "");
  const curlPath = `${binDir}/curl.exe`;

  return `${marker}
# Auto-installed by git-ai-kiro plugin. Do not edit this section manually.
(
  COMMIT_SHA=$(git rev-parse HEAD 2>/dev/null)
  if [ -z "$COMMIT_SHA" ]; then exit 0; fi
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  sleep 2

  # --- 检测 amend：如果是 git commit --amend，使用 --amend-from 标志调用 git-ai ---
  # 判定依据：HEAD reflog 最新一条是 "commit (amend)"
  # git-ai 的 amend 处理会正确地从 working_logs/<OLD_SHA>/ 读取 AI checkpoints，
  # 并结合 amend 后的新 parent 生成正确的 authorship note。
  IS_AMEND=0
  REFLOG_MSG=$(git reflog -1 --format=%gs HEAD 2>/dev/null || echo "")
  case "$REFLOG_MSG" in
    *"commit (amend)"*) IS_AMEND=1 ;;
  esac
  AMEND_ARGS=""
  if [ "$IS_AMEND" = "1" ]; then
    # git commit --amend 不会更新 ORIG_HEAD，所以 ORIG_HEAD 可能指向不相关的 commit。
    # 正确做法：始终使用 HEAD@{1}（reflog 前一条），它就是被 amend 替换掉的原始 commit。
    OLD_SHA=$(git rev-parse -q --verify "HEAD@{1}" 2>/dev/null || echo "")
    if [ -n "$OLD_SHA" ] && [ "$OLD_SHA" != "$COMMIT_SHA" ]; then
      # 删除 git-ai 之前可能已经为 COMMIT_SHA 生成的 stale note，
      # 否则 git-ai post-commit 会直接跳过（因为它检测到已经有 note）。
      git notes --ref=ai remove "$COMMIT_SHA" 2>/dev/null || true
      # 清理 SessionLogWatcher 可能在 working_logs/<COMMIT_SHA>/ 下残留的 INITIAL 文件，
      # 避免干扰 amend 处理（amend 处理使用的是 working_logs/<OLD_SHA>/）。
      rm -f "$REPO_ROOT/.git/ai/working_logs/$COMMIT_SHA/INITIAL" 2>/dev/null || true
      AMEND_ARGS=" --amend-from $OLD_SHA"
    fi
  fi

  "${binaryPath}" post-commit "$COMMIT_SHA"$AMEND_ARGS 2>/dev/null || true
  STATS=$("${binaryPath}" stats "$COMMIT_SHA" --json${ignoreArgs} 2>/dev/null)
  if [ -z "$STATS" ]; then exit 0; fi

  # --- 辅助函数：从 JSON 中提取数值字段（纯 shell 实现） ---
  json_get_num() {
    echo "$1" | grep -o "\\"$2\\"[[:space:]]*:[[:space:]]*[0-9]*" | head -1 | grep -o '[0-9]*$'
  }

  # --- 计算精确的 ai_deletions / human_deletions ---
  DIFF_JSON=$("${binaryPath}" diff "$COMMIT_SHA" --json 2>/dev/null || echo "")
  GIT_DEL=$(json_get_num "$STATS" "git_diff_deleted_lines")
  GIT_DEL=\${GIT_DEL:-0}
  AI_DEL=0

  if [ -n "$DIFF_JSON" ]; then
    # 策略1: authorship_note 中 AI prompt 的 total_deletions
    # 提取所有 total_deletions 值（排除 human tool 的情况较复杂，此处取所有 prompt 的 total_deletions 之和）
    AI_NOTE_DEL=0
    # 从 diff JSON 中提取 prompts 下所有 total_deletions（排除 tool=human 的）
    # 简化策略：提取所有 "total_deletions": N 的值求和
    for d in $(echo "$DIFF_JSON" | grep -o '"total_deletions"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$'); do
      AI_NOTE_DEL=$((AI_NOTE_DEL + d))
    done

    # 策略2: hunks 中有 prompt_id 的 deletion 行数
    # 使用 awk 解析 hunks 数组中 hunk_kind=deletion 且有 prompt_id 的条目
    AI_HUNK_DEL=$(echo "$DIFF_JSON" | awk '
      BEGIN { total=0; in_hunk=0; is_del=0; has_prompt=0; start=0; end_l=0 }
      /"hunk_kind"[[:space:]]*:[[:space:]]*"deletion"/ { is_del=1 }
      /"prompt_id"[[:space:]]*:[[:space:]]*"[^"]+/ { has_prompt=1 }
      /"start_line"[[:space:]]*:[[:space:]]*[0-9]/ { match($0, /[0-9]+/); start=substr($0, RSTART, RLENGTH)+0 }
      /"end_line"[[:space:]]*:[[:space:]]*[0-9]/ { match($0, /[0-9]+/); end_l=substr($0, RSTART, RLENGTH)+0 }
      /\\}/ {
        if (is_del && has_prompt && end_l >= start) {
          total += end_l - start + 1
        }
        is_del=0; has_prompt=0; start=0; end_l=0
      }
      END { print total }
    ')
    AI_HUNK_DEL=\${AI_HUNK_DEL:-0}

    # 取两者较大值
    if [ "$AI_NOTE_DEL" -gt "$AI_HUNK_DEL" ] 2>/dev/null; then
      AI_DEL=$AI_NOTE_DEL
    else
      AI_DEL=$AI_HUNK_DEL
    fi
  fi

  # 优先使用插件端计算的 AI 净删除行数（精确值）
  KIRO_NET_DEL_FILE="$REPO_ROOT/.git/ai/kiro_net_deletions"
  KIRO_NET_DEL=0
  if [ -f "$KIRO_NET_DEL_FILE" ]; then
    KIRO_NET_DEL=$(cat "$KIRO_NET_DEL_FILE" 2>/dev/null | tr -d '[:space:]')
    KIRO_NET_DEL=\${KIRO_NET_DEL:-0}
  fi
  if [ "$KIRO_NET_DEL" -gt 0 ] 2>/dev/null; then
    AI_DEL=$KIRO_NET_DEL
  fi

  # cap AI_DEL 到 GIT_DEL
  if [ "$AI_DEL" -gt "$GIT_DEL" ] 2>/dev/null; then
    AI_DEL=$GIT_DEL
  fi
  HUMAN_DEL=$((GIT_DEL - AI_DEL))
  if [ "$HUMAN_DEL" -lt 0 ] 2>/dev/null; then HUMAN_DEL=0; fi

  # --- 调整 STATS JSON：注入 ai_deletions/human_deletions，调整 ai_additions ---
  GIT_ADD=$(json_get_num "$STATS" "git_diff_added_lines")
  GIT_ADD=\${GIT_ADD:-0}
  MIXED=$(json_get_num "$STATS" "mixed_additions")
  MIXED=\${MIXED:-0}
  AI_ADD=$(json_get_num "$STATS" "ai_additions")
  AI_ADD=\${AI_ADD:-0}
  AI_ACCEPTED=$(json_get_num "$STATS" "ai_accepted")
  AI_ACCEPTED=\${AI_ACCEPTED:-0}
  HUMAN_ADD=$(json_get_num "$STATS" "human_additions")
  HUMAN_ADD=\${HUMAN_ADD:-0}

  # ai_additions 去除 mixed_additions（客户要求：ai_additions 只含纯 AI 行数）
  AI_ADD=$((AI_ADD - MIXED))
  if [ "$AI_ADD" -lt 0 ] 2>/dev/null; then AI_ADD=0; fi

  # cap: 不超过 git_diff_added_lines
  if [ "$GIT_ADD" -gt 0 ] 2>/dev/null; then
    if [ "$AI_ADD" -gt "$GIT_ADD" ] 2>/dev/null; then AI_ADD=$GIT_ADD; fi
    if [ "$AI_ACCEPTED" -gt "$GIT_ADD" ] 2>/dev/null; then AI_ACCEPTED=$GIT_ADD; fi
    if [ "$HUMAN_ADD" -gt "$GIT_ADD" ] 2>/dev/null; then HUMAN_ADD=$GIT_ADD; fi
  fi

  # 使用 sed 注入/替换字段到 STATS JSON
  STATS=$(echo "$STATS" | sed 's/"ai_additions"[[:space:]]*:[[:space:]]*[0-9]*/"ai_additions":'"$AI_ADD"'/')
  STATS=$(echo "$STATS" | sed 's/"ai_accepted"[[:space:]]*:[[:space:]]*[0-9]*/"ai_accepted":'"$AI_ACCEPTED"'/')
  STATS=$(echo "$STATS" | sed 's/"human_additions"[[:space:]]*:[[:space:]]*[0-9]*/"human_additions":'"$HUMAN_ADD"'/')
  # 注入 ai_deletions 和 human_deletions（在最后一个 } 前插入）
  if echo "$STATS" | grep -q '"ai_deletions"'; then
    STATS=$(echo "$STATS" | sed 's/"ai_deletions"[[:space:]]*:[[:space:]]*[0-9]*/"ai_deletions":'"$AI_DEL"'/')
  else
    STATS=$(echo "$STATS" | sed 's/}$/,"ai_deletions":'"$AI_DEL"'}/')
  fi
  if echo "$STATS" | grep -q '"human_deletions"'; then
    STATS=$(echo "$STATS" | sed 's/"human_deletions"[[:space:]]*:[[:space:]]*[0-9]*/"human_deletions":'"$HUMAN_DEL"'/')
  else
    STATS=$(echo "$STATS" | sed 's/}$/,"human_deletions":'"$HUMAN_DEL"'}/')
  fi

  # 上报后清空 kiro_net_deletions
  rm -f "$REPO_ROOT/.git/ai/kiro_net_deletions" 2>/dev/null
  REPO_NAME=$(basename "$REPO_ROOT")
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  USER_NAME=$(git config user.name 2>/dev/null)
  USER_EMAIL=$(git config user.email 2>/dev/null)
  MACHINE_ID=$(hostname | sha256sum 2>/dev/null | cut -d' ' -f1 || echo "unknown")
  REPORTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
  REMOTE_URL=$(git config remote.origin.url 2>/dev/null)
  IDEM_KEY=$(echo -n "$COMMIT_SHA:$MACHINE_ID" | sha256sum 2>/dev/null | cut -d' ' -f1 || echo "$COMMIT_SHA")
  # 获取 commit subject（%s），并做 JSON 字符串转义（反斜杠→\\\\、双引号→\\"、回车换行等控制字符）
  COMMIT_MSG_RAW=$(git log -1 --pretty=%s "$COMMIT_SHA" 2>/dev/null || echo "")
  COMMIT_MSG=$(printf '%s' "$COMMIT_MSG_RAW" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e 's/\\t/\\\\t/g' -e 's/\\r/\\\\r/g' | tr -d '\\n')
  # 从 last_upload_payload.json 中从后往前查找最近的 [userSync] 记录，提取 user_id
  USER_ID=""
  if [ -f "$REPO_ROOT/.git/ai/last_upload_payload.json" ]; then
    USER_ID=$(tac "$REPO_ROOT/.git/ai/last_upload_payload.json" 2>/dev/null | grep -m1 '\\[userSync\\]' | grep -o '"user_id":"[^"]*"' | head -1 | sed 's/"user_id":"//;s/"//' || echo "")
    # macOS 没有 tac，用 tail -r 兜底
    if [ -z "$USER_ID" ]; then
      USER_ID=$(tail -r "$REPO_ROOT/.git/ai/last_upload_payload.json" 2>/dev/null | grep -m1 '\\[userSync\\]' | grep -o '"user_id":"[^"]*"' | head -1 | sed 's/"user_id":"//;s/"//' || echo "")
    fi
  fi
  # 构建 user_id JSON 片段（如果有值）
  USER_ID_JSON=""
  if [ -n "$USER_ID" ]; then
    USER_ID_JSON=",\\"user_id\\":\\"$USER_ID\\""
  fi
  PAYLOAD="{\\"repo_name\\":\\"$REPO_NAME\\",\\"repo_remote_url\\":\\"$REMOTE_URL\\",\\"branch\\":\\"$BRANCH\\",\\"commit_sha\\":\\"$COMMIT_SHA\\",\\"commit_msg\\":\\"$COMMIT_MSG\\",\\"machine_id\\":\\"$MACHINE_ID\\",\\"user_name\\":\\"$USER_NAME\\",\\"user_email\\":\\"$USER_EMAIL\\",\\"reported_at\\":\\"$REPORTED_AT\\"$USER_ID_JSON,\\"commit_stats\\":$STATS}"
  mkdir -p "$REPO_ROOT/.git/ai" 2>/dev/null
  echo "[stats] [$REPORTED_AT] $PAYLOAD" >> "$REPO_ROOT/.git/ai/last_upload_payload.json" 2>/dev/null
  # 清理 15 天前的行（纯 shell 实现）
  LOG_FILE="$REPO_ROOT/.git/ai/last_upload_payload.json"
  if [ -f "$LOG_FILE" ]; then
    CUTOFF_DATE=$(date -u -v-15d +"%Y-%m-%d" 2>/dev/null || date -u -d "15 days ago" +"%Y-%m-%d" 2>/dev/null || echo "")
    if [ -n "$CUTOFF_DATE" ]; then
      awk -v cutoff="$CUTOFF_DATE" '
        {
          match($0, /\\[([0-9]{4}-[0-9]{2}-[0-9]{2})T/, arr)
          if (arr[1] == "" || arr[1] >= cutoff) print
        }
      ' "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE" 2>/dev/null || rm -f "$LOG_FILE.tmp" 2>/dev/null
    fi
  fi
  # 优先使用系统 curl，不存在时使用插件自带的 curl.exe（Windows 兜底）
  CURL_CMD="curl"
  if ! command -v curl >/dev/null 2>&1; then
    CURL_CMD="${curlPath}"
  fi
  "$CURL_CMD" -s -X POST "${statsUrl}" \\
    -H "Content-Type: application/json" \\
    -H "X-Idempotency-Key: $IDEM_KEY" \\
    -d "$PAYLOAD" >/dev/null 2>&1 || true
) &
${endMarker}`;
}


/**
 * Install post-commit hooks for all git repos found from workspace folders.
 */
export function installHooksForWorkspace(): void {
  const vscode = require("vscode");
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return;

  const installed = new Set<string>();
  for (const folder of folders) {
    const wsPath = folder.uri.fsPath;
    // 1. workspace 本身是 git repo 或其子目录
    const gitRoot = findGitRoot(wsPath);
    if (gitRoot && !installed.has(gitRoot)) {
      installPreCommitHook(gitRoot);
      installPostCommitHook(gitRoot);
      installed.add(gitRoot);
    }
    // 2. workspace 是 git 项目的父目录，扫描子目录
    if (!gitRoot) {
      const subRepos = findGitReposInDir(wsPath);
      for (const repo of subRepos) {
        if (!installed.has(repo)) {
          installPreCommitHook(repo);
          installPostCommitHook(repo);
          installed.add(repo);
        }
      }
    }
  }
}

// ============================================================================
// Windows hook strategy helpers
// ============================================================================

/** Cached result of `canRunShOnWindows` — probing is expensive and state is stable. */
let _shProbeResult: boolean | null = null;

/**
 * Windows-only: detect whether an `sh.exe` (typically Git Bash) is available on
 * PATH and capable of executing a simple script.
 *
 * If present, we can use the same sh-based post-commit hook as macOS/Linux,
 * avoiding PowerShell ExecutionPolicy / AppLocker friction.
 */
function canRunShOnWindows(): boolean {
  if (os.platform() !== "win32") return true;
  if (_shProbeResult !== null) return _shProbeResult;

  // Git for Windows 自带 sh.exe，且 Git 执行 hooks 时使用自己的 sh.exe，
  // 不依赖系统 PATH。所以只要 git 可用（我们已经在 git repo 中），sh hook 就能工作。
  // 但我们仍然尝试直接探测 sh.exe 以确认。

  // 策略 1: 通过 git 找到其安装目录下的 sh.exe
  try {
    const gitExecPath = spawnSync("git", ["--exec-path"], {
      timeout: 5000, encoding: "utf-8", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (gitExecPath.status === 0 && gitExecPath.stdout) {
      // git --exec-path 返回类似 "C:/Program Files/Git/mingw64/libexec/git-core"
      const execDir = gitExecPath.stdout.trim().replace(/\//g, "\\");
      const gitRoot = path.resolve(execDir, "..", "..", "..");
      const shCandidates = [
        path.join(gitRoot, "bin", "sh.exe"),
        path.join(gitRoot, "usr", "bin", "sh.exe"),
      ];
      for (const shPath of shCandidates) {
        try {
          if (fs.existsSync(shPath)) {
            const result = spawnSync(shPath, ["-c", "echo ok"], {
              timeout: 5000, encoding: "utf-8", windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
            if (result.status === 0 && (result.stdout || "").trim() === "ok") {
              console.log(`[git-ai-kiro] Detected sh.exe via git --exec-path (${shPath}) — using sh hook`);
              _shProbeResult = true;
              return true;
            }
          }
        } catch { /* try next */ }
      }
    }
  } catch { /* git --exec-path failed */ }

  // 策略 2: 直接尝试 PATH 中的 sh
  try {
    const result = spawnSync("sh", ["-c", "echo ok"], {
      timeout: 5000, encoding: "utf-8", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0 && (result.stdout || "").trim() === "ok") {
      console.log("[git-ai-kiro] Detected sh.exe in PATH — using sh hook");
      _shProbeResult = true;
      return true;
    }
  } catch { /* sh not in PATH */ }

  // 策略 3: 常见固定路径
  const fixedPaths = [
    "C:\\Program Files\\Git\\bin\\sh.exe",
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
    "C:\\Program Files (x86)\\Git\\bin\\sh.exe",
  ];
  for (const shPath of fixedPaths) {
    try {
      if (fs.existsSync(shPath)) {
        const result = spawnSync(shPath, ["-c", "echo ok"], {
          timeout: 5000, encoding: "utf-8", windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.status === 0 && (result.stdout || "").trim() === "ok") {
          console.log(`[git-ai-kiro] Detected sh.exe at fixed path (${shPath}) — using sh hook`);
          _shProbeResult = true;
          return true;
        }
      }
    } catch { /* try next */ }
  }

  // 策略 4: 如果 git 可用，Git hooks 一定能用 sh（Git 自带 sh.exe 执行 hooks）。
  // 即使我们无法直接 spawn sh.exe，Git 执行 post-commit hook 时会用自己的 sh。
  try {
    const gitVersion = spawnSync("git", ["--version"], {
      timeout: 5000, encoding: "utf-8", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (gitVersion.status === 0 && (gitVersion.stdout || "").includes("git version")) {
      console.log("[git-ai-kiro] git is available — Git will use its own sh.exe to run hooks, using sh hook");
      _shProbeResult = true;
      return true;
    }
  } catch { /* git not available */ }

  console.log("[git-ai-kiro] sh.exe not available on Windows — falling back to PowerShell hook");
  _shProbeResult = false;
  return false;
}

/** Cached result of `canRunPowerShellHere`. */
let _psProbeResult: boolean | null = null;

/**
 * Windows-only: probe whether a simple `.ps1` script can be executed under the
 * current user's ExecutionPolicy.
 *
 * Writes a tiny ps1 to the hooks directory that echoes "PowerShell works OK",
 * runs it with `-ExecutionPolicy Bypass` (same as our hook invocation) to
 * verify the exec is not blocked by AppLocker, and cleans up afterwards.
 */
function canRunPowerShellHere(hooksDir: string): boolean {
  if (os.platform() !== "win32") return true;
  if (_psProbeResult !== null) return _psProbeResult;

  const probePath = path.join(hooksDir, ".git-ai-probe.ps1");
  const probeContent = "Write-Output 'PowerShell works OK'\r\n";
  try {
    fs.writeFileSync(probePath, probeContent, "utf-8");
    const exe = findPowerShellExe();
    if (!exe) {
      console.log("[git-ai-kiro] powershell.exe not found in PATH");
      _psProbeResult = false;
      return false;
    }
    const result = spawnSync(exe,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probePath],
      { timeout: 10_000, encoding: "utf-8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    const ok = result.status === 0 && (result.stdout || "").includes("PowerShell works OK");
    _psProbeResult = ok;
    if (ok) {
      console.log("[git-ai-kiro] PowerShell probe succeeded");
    } else {
      console.warn(`[git-ai-kiro] PowerShell probe failed: status=${result.status}, stderr=${(result.stderr || "").slice(0, 300)}`);
    }
    return ok;
  } catch (err) {
    console.warn(`[git-ai-kiro] PowerShell probe error: ${err}`);
    _psProbeResult = false;
    return false;
  } finally {
    try { fs.unlinkSync(probePath); } catch { /* ignore */ }
  }
}

function findPowerShellExe(): string | null {
  const fixed = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  if (fs.existsSync(fixed)) return fixed;
  try {
    // whereis fallback
    const result = spawnSync("where", ["powershell.exe"], {
      timeout: 3000, encoding: "utf-8", windowsHide: true,
    });
    if (result.status === 0 && (result.stdout || "").trim()) {
      return (result.stdout || "").split(/\r?\n/)[0].trim();
    }
  } catch { /* ignore */ }
  return null;
}

/** Only show the warning once per session */
let _psWarningShown = false;

/**
 * Surface a warning message to the user with the exact PowerShell command to
 * unblock ExecutionPolicy. Uses vscode.window.showWarningMessage when the API
 * is available, otherwise logs to console.
 */
function notifyPowerShellBlocked(): void {
  if (_psWarningShown) return;
  _psWarningShown = true;

  const msg =
    "无权限执行PowerShell脚本，影响代码指标上报，请以管理员身份打开 PowerShell，执行以下命令修改执行策略：\n" +
    "Set-ExecutionPolicy RemoteSigned -Scope CurrentUser";
  console.warn(`[git-ai-kiro] ${msg}`);

  try {
    const vscode = require("vscode");
    if (vscode?.window?.showWarningMessage) {
      const copyAction = "复制命令";
      vscode.window.showWarningMessage(msg, copyAction).then((choice: string | undefined) => {
        if (choice === copyAction && vscode.env?.clipboard?.writeText) {
          vscode.env.clipboard.writeText("Set-ExecutionPolicy RemoteSigned -Scope CurrentUser");
        }
      });
    }
  } catch { /* vscode not available (e.g. unit tests) */ }
}

// ============================================================================
// PowerShell hook generator (fallback when sh.exe is not available on Windows)
// ============================================================================

function buildHookSectionWindows(
  binaryPath: string,
  marker: string,
  endMarker: string,
  hooksDir: string,
): string {
  const { statsUrl, ignoreArgs } = getHookConfig();

  const ps1Path = path.join(hooksDir, "git-ai-post-commit.ps1");
  const binaryWin = binaryPath.replace(/\//g, "\\");
  const ignoreArgsPs = ignoreArgs.replace(/"/g, "'");

  const ps1Lines = [
    "# Auto-generated by git-ai-kiro plugin",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
    "Start-Sleep -Seconds 2",
    "$commitSha = git rev-parse HEAD 2>$null",
    "if (-not $commitSha) { exit 0 }",
    "$repoRoot = git rev-parse --show-toplevel 2>$null",
    "# Detect amend: call git-ai with --amend-from flag so the proper amend handler runs",
    "$reflogMsg = git reflog -1 --format=%gs HEAD 2>$null",
    "$isAmend = $false",
    "if ($reflogMsg -and $reflogMsg -match 'commit \\(amend\\)') { $isAmend = $true }",
    "$amendArgs = @()",
    "if ($isAmend) {",
    "  # git commit --amend 不更新 ORIG_HEAD，始终用 HEAD@{1} 获取被 amend 的原始 commit",
    "  $oldSha = git rev-parse -q --verify 'HEAD@{1}' 2>$null",
    "  if ($oldSha -and $oldSha -ne $commitSha) {",
    "    # Delete stale note on the new commit sha so git-ai reprocesses it",
    "    & git notes --ref=ai remove $commitSha 2>$null | Out-Null",
    "    # Remove INITIAL that SessionLogWatcher may have left under working_logs/<commitSha>/",
    "    $commitInitialPath = Join-Path (Join-Path (Join-Path (Join-Path $repoRoot '.git') 'ai') (Join-Path 'working_logs' $commitSha)) 'INITIAL'",
    "    if (Test-Path $commitInitialPath) { Remove-Item $commitInitialPath -ErrorAction SilentlyContinue }",
    "    $amendArgs = @('--amend-from', $oldSha)",
    "  }",
    "}",
    '& "' + binaryWin + '" post-commit $commitSha @amendArgs 2>$null',
    '$stats = & "' + binaryWin + '" stats $commitSha --json' + ignoreArgsPs + " 2>$null",
    "if (-not $stats) { exit 0 }",
    "if ($stats -is [array]) { $stats = $stats -join '' }",
    '$diffJson = & "' + binaryWin + '" diff $commitSha --json 2>$null',
    "if ($diffJson -is [array]) { $diffJson = $diffJson -join '' }",
    "$statsObj = $stats | ConvertFrom-Json",
    "$gitDel = if ($statsObj.git_diff_deleted_lines) { [int]$statsObj.git_diff_deleted_lines } else { 0 }",
    "$aiNoteDel = 0",
    "$aiHunkDel = 0",
    "if ($diffJson) {",
    "  try {",
    "    $diffData = $diffJson | ConvertFrom-Json",
    "    foreach ($c in $diffData.commits.PSObject.Properties.Value) {",
    "      $noteStr = $c.authorship_note",
    "      if ($noteStr) {",
    "        $idx = $noteStr.IndexOf('---')",
    "        if ($idx -ge 0) { $noteStr = $noteStr.Substring($idx + 3).Trim() }",
    "        try {",
    "          $note = $noteStr | ConvertFrom-Json",
    "          foreach ($p in $note.prompts.PSObject.Properties.Value) {",
    "            $tool = $p.agent_id.tool",
    "            if ($tool -and $tool -ne 'human') { $aiNoteDel += [int]$p.total_deletions }",
    "          }",
    "        } catch {}",
    "      }",
    "    }",
    "    foreach ($h in $diffData.hunks) {",
    "      if ($h.hunk_kind -eq 'deletion' -and $h.prompt_id) {",
    "        $aiHunkDel += $h.end_line - $h.start_line + 1",
    "      }",
    "    }",
    "  } catch {}",
    "}",
    "$aiDel = [Math]::Min([Math]::Max($aiNoteDel, $aiHunkDel), $gitDel)",
    "try {",
    "  $netDelFile = Join-Path (Join-Path (Join-Path $repoRoot '.git') 'ai') 'kiro_net_deletions'",
    "  $kiroNetDel = 0",
    "  if (Test-Path $netDelFile) {",
    "    try { $kiroNetDel = [int](Get-Content $netDelFile -Raw).Trim() } catch {}",
    "  }",
    "  if ($kiroNetDel -gt 0) { $aiDel = [Math]::Min($kiroNetDel, $gitDel) }",
    "} catch {}",
    "$humanDel = [Math]::Max(0, $gitDel - $aiDel)",
    '$statsObj | Add-Member -NotePropertyName "ai_deletions" -NotePropertyValue $aiDel -Force',
    '$statsObj | Add-Member -NotePropertyName "human_deletions" -NotePropertyValue $humanDel -Force',
    "try { Remove-Item (Join-Path (Join-Path (Join-Path $repoRoot '.git') 'ai') 'kiro_net_deletions') -ErrorAction SilentlyContinue } catch {}",
    "$mixed = if ($statsObj.mixed_additions) { [int]$statsObj.mixed_additions } else { 0 }",
    "$pureAi = [Math]::Max(0, [int]$statsObj.ai_additions - $mixed)",
    '$statsObj.ai_additions = $pureAi',
    "$gitAdd = if ($statsObj.git_diff_added_lines) { [int]$statsObj.git_diff_added_lines } else { 0 }",
    "if ($gitAdd -gt 0) {",
    "  $statsObj.ai_additions = [Math]::Min([int]$statsObj.ai_additions, $gitAdd)",
    "  $statsObj.ai_accepted = [Math]::Min([int]$statsObj.ai_accepted, $gitAdd)",
    "  $statsObj.human_additions = [Math]::Min([int]$statsObj.human_additions, $gitAdd)",
    "}",
    "$stats = $statsObj | ConvertTo-Json -Depth 10 -Compress",
    "$repoName = if ($repoRoot) { Split-Path $repoRoot -Leaf } else { 'unknown' }",
    "$branch = git rev-parse --abbrev-ref HEAD 2>$null",
    "$userName = git config user.name 2>$null",
    "$userEmail = git config user.email 2>$null",
    "$hostname = [System.Net.Dns]::GetHostName()",
    "$machineId = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($hostname))).Replace('-','').ToLower()",
    "$reportedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')",
    "$remoteUrl = git config remote.origin.url 2>$null",
    "if (-not $remoteUrl) { $remoteUrl = '' }",
    "if (-not $userName) { $userName = '' }",
    "if (-not $userEmail) { $userEmail = '' }",
    "if (-not $branch) { $branch = '' }",
    "$commitMsg = git log -1 --pretty=%s $commitSha 2>$null",
    "if ($commitMsg -is [array]) { $commitMsg = $commitMsg -join \"`n\" }",
    "if (-not $commitMsg) { $commitMsg = '' }",
    "# 从 last_upload_payload.json 中从后往前查找最近的 [userSync] 记录，提取 user_id",
    "$userId = ''",
    "$logPath = Join-Path (Join-Path (Join-Path $repoRoot '.git') 'ai') 'last_upload_payload.json'",
    "if (Test-Path $logPath) {",
    "  $logLines = Get-Content $logPath",
    "  for ($i = $logLines.Count - 1; $i -ge 0; $i--) {",
    "    if ($logLines[$i] -match '\\[userSync\\]' -and $logLines[$i] -match '\"user_id\":\"([^\"]+)\"') {",
    "      $userId = $Matches[1]; break",
    "    }",
    "  }",
    "}",
    '$idemRaw = "${commitSha}:${machineId}"',
    "$idemKey = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($idemRaw))).Replace('-','').ToLower()",
    "$payload = [ordered]@{",
    "  repo_name = [string]$repoName",
    "  repo_remote_url = [string]$remoteUrl",
    "  branch = [string]$branch",
    "  commit_sha = [string]$commitSha",
    "  commit_msg = [string]$commitMsg",
    "  machine_id = [string]$machineId",
    "  user_name = [string]$userName",
    "  user_email = [string]$userEmail",
    "  reported_at = [string]$reportedAt",
    "  commit_stats = ($stats | ConvertFrom-Json)",
    "}",
    "if ($userId) { $payload['user_id'] = [string]$userId }",
    "$body = $payload | ConvertTo-Json -Depth 10 -Compress",
    "try {",
    "  $debugDir = Join-Path (Join-Path $repoRoot '.git') 'ai'",
    "  if (-not (Test-Path $debugDir)) { New-Item -ItemType Directory -Path $debugDir -Force | Out-Null }",
    "  $logFile = Join-Path $debugDir 'last_upload_payload.json'",
    "  \"[stats] [$reportedAt] $body\" | Out-File -FilePath $logFile -Encoding utf8 -Append",
    "  $cutoff = (Get-Date).AddDays(-15)",
    "  if (Test-Path $logFile) {",
    "    $lines = Get-Content $logFile",
    "    $kept = @()",
    "    foreach ($l in $lines) {",
    "      if ($l -match '\\[(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z?)\\]') {",
    "        try { $ts = [datetime]::Parse($Matches[1]); if ($ts -ge $cutoff) { $kept += $l } } catch { $kept += $l }",
    "      } else { $kept += $l }",
    "    }",
    "    $kept | Out-File -FilePath $logFile -Encoding utf8 -Force",
    "  }",
    "} catch {}",
    "$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "try {",
    '  Invoke-RestMethod -Uri "' + statsUrl + '" -Method Post -ContentType "application/json; charset=utf-8" -Headers @{ "X-Idempotency-Key"=$idemKey } -Body $bodyBytes -ErrorAction SilentlyContinue | Out-Null',
    "} catch {}",
  ];

  try {
    fs.writeFileSync(ps1Path, ps1Lines.join("\r\n"), "utf-8");
    console.log("[git-ai-kiro] Wrote PowerShell hook script: " + ps1Path);
  } catch (err) {
    console.error("[git-ai-kiro] Failed to write PS1 hook: " + err);
  }

  const ps1Win = ps1Path.replace(/\//g, "\\");
  const psExe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  return (
    marker +
    "\n# Auto-installed by git-ai-kiro plugin. Do not edit this section manually.\n" +
    "if [ -f \"" + psExe.replace(/\\/g, "/") + "\" ]; then\n" +
    "  \"" + psExe.replace(/\\/g, "/") + "\" -NoProfile -ExecutionPolicy Bypass -File \"" + ps1Win + "\" &\n" +
    "elif command -v powershell.exe >/dev/null 2>&1; then\n" +
    "  powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"" + ps1Win + "\" &\n" +
    "fi\n" +
    endMarker
  );
}
