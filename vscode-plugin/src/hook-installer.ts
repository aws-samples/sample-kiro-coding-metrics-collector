/**
 * HookInstaller - 安装 Kiro hooks 到工作区
 *
 * Hooks 职责：
 *   - promptSubmit → human checkpoint + 写 AI 活跃标记文件
 *   - agentStop → human checkpoint + 删除 AI 活跃标记文件
 *
 * AI 活跃标记文件 /tmp/.git-ai-kiro-active：
 *   - 存在 = AI agent 正在工作，文件保存应触发 ai_agent checkpoint
 *   - 不存在 = 人工编辑阶段，文件保存不触发任何 checkpoint
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const MARKER = "git-ai-for-kiro";

const CHECKPOINT_SCRIPT = `#!/usr/bin/env bash
# git-ai checkpoint helper - 由 ${MARKER} 插件自动生成
set -euo pipefail
TYPE="\${1:-human}"
SID_FILE="/tmp/.git-ai-kiro-sid"
ACTIVE_FILE="/tmp/.git-ai-kiro-active"
command -v git-ai &>/dev/null || exit 0
[ -f "$SID_FILE" ] && SID=$(cat "$SID_FILE") || { SID="kiro-$(date +%s)-$$"; echo "$SID" > "$SID_FILE"; }

run_cp() {
  local R="$1"
  if [ "$TYPE" = "ai_agent" ]; then
    echo "{\\"type\\":\\"ai_agent\\",\\"repo_working_dir\\":\\"$R\\",\\"agent_name\\":\\"kiro\\",\\"model\\":\\"kiro-ai\\",\\"conversation_id\\":\\"$SID\\",\\"transcript\\":{\\"messages\\":[{\\"type\\":\\"assistant\\",\\"text\\":\\"Kiro AI edit\\"}]}}" | git-ai checkpoint agent-v1 --hook-input stdin 2>&1 || true
  else
    echo "{\\"type\\":\\"human\\",\\"repo_working_dir\\":\\"$R\\"}" | git-ai checkpoint agent-v1 --hook-input stdin 2>&1 || true
  fi
}

if git rev-parse --show-toplevel &>/dev/null; then
  run_cp "$(git rev-parse --show-toplevel)"
else
  for d in */; do
    [ -d "\${d}.git" ] && run_cp "$(cd "$d" && git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || true
  done
fi
`;

function getHooks(scriptPath: string): Record<string, object> {
  return {
    "git-ai-prompt-submit.kiro.hook": {
      enabled: true,
      name: "git-ai: prompt 开始",
      version: "1",
      description: `用户提交 prompt 时：human checkpoint + 标记 AI 活跃。由 ${MARKER} 插件自动生成。`,
      when: { type: "promptSubmit" },
      then: {
        type: "runCommand",
        command: `bash -c 'echo "kiro-$(date +%s)-$$" > /tmp/.git-ai-kiro-sid; touch /tmp/.git-ai-kiro-active; bash "${scriptPath}" human'`,
      },
    },
    "git-ai-agent-stop.kiro.hook": {
      enabled: true,
      name: "git-ai: agent 结束",
      version: "1",
      description: `Agent 结束后：human checkpoint + 清除 AI 活跃标记。由 ${MARKER} 插件自动生成。`,
      when: { type: "agentStop" },
      then: {
        type: "runCommand",
        command: `bash -c 'rm -f /tmp/.git-ai-kiro-active; bash "${scriptPath}" human'`,
      },
    },
  };
}

export function installHooksForAllWorkspaces(): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return;
  for (const folder of folders) installHooksForFolder(folder.uri.fsPath);
}

export function installHooksForFolder(folderPath: string): void {
  const kiroDir = path.join(folderPath, ".kiro");
  const hooksDir = path.join(kiroDir, "hooks");
  const scriptPath = path.join(kiroDir, "git-ai-checkpoint.sh");

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(scriptPath, CHECKPOINT_SCRIPT, { mode: 0o755 });

    for (const [filename, hookDef] of Object.entries(getHooks(scriptPath))) {
      const hookPath = path.join(hooksDir, filename);
      if (fs.existsSync(hookPath)) {
        try {
          const existing = fs.readFileSync(hookPath, "utf-8");
          if (!existing.includes(MARKER)) continue;
        } catch { continue; }
      }
      fs.writeFileSync(hookPath, JSON.stringify(hookDef, null, 2), "utf-8");
    }

    // 清理旧版（包括错误扩展名的文件）
    for (const old of [
      "git-ai-post-write.json", "git-ai-pre-write.json", "git-ai-debug.json",
      "git-ai-verify.kiro.hook", "git-ai-prompt-submit.json", "git-ai-agent-stop.json",
      "prompt-test.kiro.hook",
    ]) {
      const p = path.join(hooksDir, old);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* */ }
    }

    console.log(`[git-ai-kiro] hooks 已安装到 ${hooksDir}`);
  } catch (err) {
    console.error(`[git-ai-kiro] 安装 hooks 失败:`, err);
  }
}

export function removeHooksForFolder(folderPath: string): void {
  const kiroDir = path.join(folderPath, ".kiro");
  const hooksDir = path.join(kiroDir, "hooks");

  try { fs.unlinkSync(path.join(kiroDir, "git-ai-checkpoint.sh")); } catch { /* */ }
  for (const f of [
    "git-ai-prompt-submit.kiro.hook", "git-ai-agent-stop.kiro.hook",
    "git-ai-prompt-submit.json", "git-ai-agent-stop.json",
    "git-ai-post-write.json", "git-ai-pre-write.json",
  ]) {
    const p = path.join(hooksDir, f);
    try {
      if (fs.existsSync(p)) {
        const c = fs.readFileSync(p, "utf-8");
        if (c.includes(MARKER)) fs.unlinkSync(p);
      }
    } catch { /* */ }
  }
}

export function registerWorkspaceWatcher(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const added of event.added) installHooksForFolder(added.uri.fsPath);
      for (const removed of event.removed) removeHooksForFolder(removed.uri.fsPath);
    })
  );
}
