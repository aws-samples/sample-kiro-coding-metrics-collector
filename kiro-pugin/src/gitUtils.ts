/**
 * Git utility functions — finding git root, installing hooks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

  // On Windows, install both post-commit (sh shim) and post-commit.ps1 (actual logic)
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

  const binaryEscaped = binary.replace(/\\/g, "/");
  const hookSection = isWindows
    ? buildHookSectionWindows(binaryEscaped, marker, endMarker, hooksDir)
    : buildHookSectionUnix(binaryEscaped, marker, endMarker);

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

  return `${marker}
# Auto-installed by git-ai-kiro plugin. Do not edit this section manually.
(
  COMMIT_SHA=$(git rev-parse HEAD 2>/dev/null)
  if [ -z "$COMMIT_SHA" ]; then exit 0; fi
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  sleep 2
  "${binaryPath}" post-commit "$COMMIT_SHA" 2>/dev/null || true
  STATS=$("${binaryPath}" stats "$COMMIT_SHA" --json${ignoreArgs} 2>/dev/null)
  if [ -z "$STATS" ]; then exit 0; fi
  # 计算精确的 ai_deletions / human_deletions
  # 策略1: 从 authorship_note 中提取 AI prompt 的 total_deletions（AI 删除部分行时有 checkpoint）
  # 策略2: 从 hunks 中统计有 prompt_id 的 deletion 行数（AI 删除整个文件时无 checkpoint，但被删行有 AI 归属）
  # 取两者的较大值，cap 到 git_diff_deleted_lines
  DIFF_JSON=$("${binaryPath}" diff "$COMMIT_SHA" --json 2>/dev/null || echo "")
  if [ -n "$DIFF_JSON" ] && command -v python3 >/dev/null 2>&1; then
    STATS=$(python3 -c "
import sys, json
stats = json.loads(sys.argv[1])
diff_data = json.loads(sys.argv[2])
git_del = stats.get('git_diff_deleted_lines', 0)
# 策略1: authorship_note 中 AI prompt 的 total_deletions
ai_note_del = 0
for c in diff_data.get('commits', {}).values():
    note_str = c.get('authorship_note', '')
    idx = note_str.find('---')
    if idx >= 0:
        note_str = note_str[idx+3:].strip()
    try:
        note = json.loads(note_str)
        for p in note.get('prompts', {}).values():
            tool = p.get('agent_id', {}).get('tool', '')
            if tool and tool != 'human':
                ai_note_del += p.get('total_deletions', 0)
    except: pass
# 策略2: hunks 中有 prompt_id 的 deletion 行数
ai_hunk_del = 0
for h in diff_data.get('hunks', []):
    if h.get('hunk_kind') == 'deletion' and h.get('prompt_id'):
        ai_hunk_del += h.get('end_line', 0) - h.get('start_line', 0) + 1
ai_del = min(max(ai_note_del, ai_hunk_del), git_del)
# 优先使用插件端计算的 AI 净删除行数（精确值）
import os
kiro_net_del_file = os.path.join(sys.argv[3]) if len(sys.argv) > 3 else ''
kiro_net_del = 0
if kiro_net_del_file:
    try:
        with open(kiro_net_del_file) as f:
            kiro_net_del = int(f.read().strip()) or 0
    except: pass
if kiro_net_del > 0:
    ai_del = min(kiro_net_del, git_del)
stats['ai_deletions'] = ai_del
stats['human_deletions'] = max(0, git_del - ai_del)
# ai_additions 去除 mixed_additions（客户要求：ai_additions 只含纯 AI 行数）
mixed = stats.get('mixed_additions', 0)
stats['ai_additions'] = max(0, stats.get('ai_additions', 0) - mixed)
# cap: ai_additions、ai_accepted、human_additions 不超过 git_diff_added_lines
git_add = stats.get('git_diff_added_lines', 0)
if git_add > 0:
    stats['ai_additions'] = min(stats['ai_additions'], git_add)
    stats['ai_accepted'] = min(stats.get('ai_accepted', 0), git_add)
    stats['human_additions'] = min(stats.get('human_additions', 0), git_add)
print(json.dumps(stats))
" "$STATS" "$DIFF_JSON" "$REPO_ROOT/.git/ai/kiro_net_deletions" 2>/dev/null || echo "$STATS")
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
  PAYLOAD="{\\"repo_name\\":\\"$REPO_NAME\\",\\"repo_remote_url\\":\\"$REMOTE_URL\\",\\"branch\\":\\"$BRANCH\\",\\"commit_sha\\":\\"$COMMIT_SHA\\",\\"machine_id\\":\\"$MACHINE_ID\\",\\"user_name\\":\\"$USER_NAME\\",\\"user_email\\":\\"$USER_EMAIL\\",\\"reported_at\\":\\"$REPORTED_AT\\",\\"commit_stats\\":$STATS}"
  mkdir -p "$REPO_ROOT/.git/ai" 2>/dev/null
  echo "[stats] [$REPORTED_AT] $PAYLOAD" >> "$REPO_ROOT/.git/ai/last_upload_payload.json" 2>/dev/null
  # 清理 15 天前的行
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import sys, os, re
from datetime import datetime, timedelta, timezone
f = sys.argv[1]
try:
    cutoff = datetime.now(timezone.utc) - timedelta(days=15)
    lines = open(f).readlines()
    kept = []
    for l in lines:
        m = re.search(r'\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]', l)
        if not m: kept.append(l); continue
        try:
            ts = datetime.fromisoformat(m.group(1).replace('Z','+00:00'))
            if ts >= cutoff: kept.append(l)
        except: kept.append(l)
    open(f,'w').writelines(kept)
except: pass
" "$REPO_ROOT/.git/ai/last_upload_payload.json" 2>/dev/null
  fi
  curl -s -X POST "${statsUrl}" \\
    -H "Content-Type: application/json" \\
    -H "X-Idempotency-Key: $IDEM_KEY" \\
    -d "$PAYLOAD" >/dev/null 2>&1 || true
) &
${endMarker}`;
}

function buildHookSectionWindows(binaryPath: string, marker: string, endMarker: string, hooksDir: string): string {
  const { statsUrl, ignoreArgs } = getHookConfig();

  // Write a PowerShell script alongside the hook
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
    "# Convert working logs to Git Notes (authorship data)",
    '& "' + binaryWin + '" post-commit $commitSha 2>$null',
    '$stats = & "' + binaryWin + '" stats $commitSha --json' + ignoreArgsPs + " 2>$null",
    "if (-not $stats) { exit 0 }",
    "# Ensure stats is a single string (not array of lines)",
    "if ($stats -is [array]) { $stats = $stats -join '' }",
    "# 计算精确的 ai_deletions / human_deletions",
    "# 策略1: authorship_note 中 AI prompt 的 total_deletions",
    "# 策略2: hunks 中有 prompt_id 的 deletion 行数",
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
    "# 优先使用插件端计算的 AI 净删除行数",
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
    "# 上报后清空 kiro_net_deletions",
    "try { Remove-Item (Join-Path (Join-Path (Join-Path $repoRoot '.git') 'ai') 'kiro_net_deletions') -ErrorAction SilentlyContinue } catch {}",
    "# ai_additions 去除 mixed_additions",
    "$mixed = if ($statsObj.mixed_additions) { [int]$statsObj.mixed_additions } else { 0 }",
    "$pureAi = [Math]::Max(0, [int]$statsObj.ai_additions - $mixed)",
    '$statsObj.ai_additions = $pureAi',
    "# cap: 不超过 git_diff_added_lines",
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
    '$idemRaw = "${commitSha}:${machineId}"',
    "$idemKey = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($idemRaw))).Replace('-','').ToLower()",
    "# Build payload using hashtable and ConvertTo-Json with explicit UTF-8 encoding",
    "$payload = [ordered]@{",
    "  repo_name = [string]$repoName",
    "  repo_remote_url = [string]$remoteUrl",
    "  branch = [string]$branch",
    "  commit_sha = [string]$commitSha",
    "  machine_id = [string]$machineId",
    "  user_name = [string]$userName",
    "  user_email = [string]$userEmail",
    "  reported_at = [string]$reportedAt",
    "  commit_stats = ($stats | ConvertFrom-Json)",
    "}",
    "$body = $payload | ConvertTo-Json -Depth 10 -Compress",
    "# 追加到调试文件",
    "try {",
    "  $debugDir = Join-Path (Join-Path $repoRoot '.git') 'ai'",
    "  if (-not (Test-Path $debugDir)) { New-Item -ItemType Directory -Path $debugDir -Force | Out-Null }",
    "  $logFile = Join-Path $debugDir 'last_upload_payload.json'",
    "  \"[stats] [$reportedAt] $body\" | Out-File -FilePath $logFile -Encoding utf8 -Append",
    "  # 清理 15 天前的行",
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

  // Windows: 用反斜杠路径，查找 powershell.exe 实际位置
  const ps1Win = ps1Path.replace(/\//g, "\\");
  const psExe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  return marker + "\n# Auto-installed by git-ai-kiro plugin. Do not edit this section manually.\nif [ -f \"" + psExe.replace(/\\/g, "/") + "\" ]; then\n  \"" + psExe.replace(/\\/g, "/") + "\" -NoProfile -ExecutionPolicy Bypass -File \"" + ps1Win + "\" &\nelif command -v powershell.exe >/dev/null 2>&1; then\n  powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"" + ps1Win + "\" &\nfi\n" + endMarker;
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
