/**
 * git-ai 自动安装器
 *
 * 插件激活时检测 git-ai 是否已安装，未安装则提示用户并自动安装。
 * 安装方式：
 *   - macOS/Linux/WSL: curl -sSL https://usegitai.com/install.sh | bash
 *   - Windows (non-WSL): powershell irm https://usegitai.com/install.ps1 | iex
 */

import * as vscode from "vscode";
import { execSync, exec } from "child_process";
import * as fs from "fs";
import * as os from "os";

const COMMON_PATHS = [
  `${os.homedir()}/.git-ai/bin/git-ai`,
  `${os.homedir()}/.cargo/bin/git-ai`,
  "/usr/local/bin/git-ai",
  "/opt/homebrew/bin/git-ai",
];

/** 检测 git-ai 是否已安装 */
export function isGitAiInstalled(): boolean {
  // 直接尝试
  try {
    execSync("git-ai --version", { timeout: 3000, stdio: "ignore" });
    return true;
  } catch { /* continue */ }

  // 登录 shell
  try {
    const p = execSync('bash -ilc "which git-ai" 2>/dev/null', {
      timeout: 5000, encoding: "utf-8",
    }).trim();
    if (p) return true;
  } catch { /* continue */ }

  // 常见路径
  return COMMON_PATHS.some((p) => fs.existsSync(p));
}

/** 自动安装 git-ai，返回是否成功 */
export async function autoInstallGitAi(): Promise<boolean> {
  const platform = os.platform();

  const choice = await vscode.window.showInformationMessage(
    "git-ai 未安装。是否自动安装？（用于追踪 AI 代码指标）",
    "自动安装",
    "手动安装",
    "跳过"
  );

  if (choice === "跳过") return false;

  if (choice === "手动安装") {
    vscode.env.openExternal(
      vscode.Uri.parse("https://github.com/git-ai-project/git-ai#quick-start")
    );
    return false;
  }

  if (choice !== "自动安装") return false;

  // 执行安装
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "正在安装 git-ai...",
      cancellable: false,
    },
    async () => {
      try {
        if (platform === "win32") {
          await runInstallWindows();
        } else {
          await runInstallUnix();
        }

        // 验证安装
        // 安装后 PATH 可能还没更新，直接检查常见路径
        await new Promise((r) => setTimeout(r, 2000));

        if (isGitAiInstalled()) {
          vscode.window.showInformationMessage("git-ai 安装成功！");
          return true;
        }

        // 可能需要重启 shell 才能生效
        vscode.window.showInformationMessage(
          "git-ai 安装完成，可能需要重启 Kiro 才能生效。"
        );
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`git-ai 安装失败: ${msg}`);
        return false;
      }
    }
  );
}

/** macOS/Linux 安装 */
function runInstallUnix(): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = 'curl -sSL https://usegitai.com/install.sh | bash';
    console.log(`[git-ai-kiro] 执行安装: ${cmd}`);

    exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
      console.log("[git-ai-kiro] 安装 stdout:", stdout);
      if (stderr) console.log("[git-ai-kiro] 安装 stderr:", stderr);

      if (error) {
        reject(new Error(`安装脚本执行失败: ${stderr || error.message}`));
      } else {
        resolve();
      }
    });
  });
}

/** Windows 安装 */
function runInstallWindows(): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd =
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://usegitai.com/install.ps1 | iex"';
    console.log(`[git-ai-kiro] 执行安装: ${cmd}`);

    exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
      console.log("[git-ai-kiro] 安装 stdout:", stdout);
      if (stderr) console.log("[git-ai-kiro] 安装 stderr:", stderr);

      if (error) {
        reject(new Error(`安装脚本执行失败: ${stderr || error.message}`));
      } else {
        resolve();
      }
    });
  });
}
