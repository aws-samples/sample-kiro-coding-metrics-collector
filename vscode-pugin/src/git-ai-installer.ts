/**
 * git-ai 自动安装器
 * 插件激活时检测 git-ai 是否已安装，未安装则提示用户并自动安装。
 */

import * as vscode from "vscode";
import { exec } from "child_process";
import * as fs from "fs";
import * as os from "os";

const COMMON_PATHS = [
  `${os.homedir()}/.git-ai/bin/git-ai`,
  `${os.homedir()}/.cargo/bin/git-ai`,
  "/usr/local/bin/git-ai",
  "/opt/homebrew/bin/git-ai",
];

export function isGitAiInstalled(): boolean {
  try {
    require("child_process").execSync("git-ai --version", { timeout: 3000, stdio: "ignore" });
    return true;
  } catch { /* */ }
  try {
    const p = require("child_process").execSync('bash -ilc "which git-ai" 2>/dev/null', { timeout: 5000, encoding: "utf-8" }).trim();
    if (p) return true;
  } catch { /* */ }
  return COMMON_PATHS.some((p) => fs.existsSync(p));
}

export async function autoInstallGitAi(): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    "git-ai 未安装。是否自动安装？（用于追踪 AI 代码指标）",
    "自动安装", "手动安装", "跳过"
  );
  if (choice === "跳过") return false;
  if (choice === "手动安装") {
    vscode.env.openExternal(vscode.Uri.parse("https://github.com/git-ai-project/git-ai#quick-start"));
    return false;
  }
  if (choice !== "自动安装") return false;

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "正在安装 git-ai...", cancellable: false },
    async () => {
      try {
        const cmd = os.platform() === "win32"
          ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://usegitai.com/install.ps1 | iex"'
          : "curl -sSL https://usegitai.com/install.sh | bash";
        await new Promise<void>((resolve, reject) => {
          exec(cmd, { timeout: 120000 }, (error, _stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve();
          });
        });
        await new Promise((r) => setTimeout(r, 2000));
        if (isGitAiInstalled()) {
          vscode.window.showInformationMessage("git-ai 安装成功！");
          return true;
        }
        vscode.window.showInformationMessage("git-ai 安装完成，可能需要重启 Kiro 才能生效。");
        return true;
      } catch (err) {
        vscode.window.showErrorMessage(`git-ai 安装失败: ${err instanceof Error ? err.message : err}`);
        return false;
      }
    }
  );
}
