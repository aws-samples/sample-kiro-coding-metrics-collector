/**
 * git-ai for Kiro - VSCode/Kiro 扩展入口
 *
 * 策略：
 *   1. Kiro hooks 标记 AI 活跃窗口：
 *      - promptSubmit → 写标记文件，表示 AI agent 开始工作
 *      - agentStop → 删除标记文件 + human checkpoint
 *   2. 扩展监听 onDidSaveTextDocument：
 *      - 如果 AI 活跃标记存在 → ai_agent checkpoint
 *      - 如果 AI 活跃标记不存在 → 不做任何事（human 由 hooks 处理）
 *
 * 为什么用 onDidSaveTextDocument 而不是 onDidChangeTextDocument：
 *   - 保存后文件已写入磁盘，git-ai 能正确读取和 diff
 *   - onDidChangeTextDocument 时文件可能还在内存中
 *   - 不需要启发式检测"是否是 AI 编辑"——用标记文件判断
 *
 * 为什么不在 onDidSaveTextDocument 中触发 human checkpoint：
 *   - Kiro 写文件后自动保存，会在 agentStop 之前触发
 *   - 如果触发 human checkpoint 会覆盖 AI 归属
 *   - human checkpoint 完全由 promptSubmit 和 agentStop hooks 处理
 */

import * as vscode from "vscode";
import { CheckpointManager } from "./checkpoint-manager";
import {
  installHooksForAllWorkspaces,
  registerWorkspaceWatcher,
  removeHooksForFolder,
} from "./hook-installer";
import { isGitAiInstalled, autoInstallGitAi } from "./git-ai-installer";

let checkpointManager: CheckpointManager;

export function activate(context: vscode.ExtensionContext) {
  console.log("[git-ai-kiro] 插件激活");

  checkpointManager = new CheckpointManager();

  // 检测并自动安装 git-ai
  if (!isGitAiInstalled()) {
    autoInstallGitAi().then((installed) => {
      if (installed) {
        // 安装成功后重新初始化
        console.log("[git-ai-kiro] git-ai 安装成功，重新初始化");
        checkpointManager = new CheckpointManager();
      }
    });
  }

  // 安装 Kiro hooks
  installHooksForAllWorkspaces();
  registerWorkspaceWatcher(context);

  // 命令注册
  context.subscriptions.push(
    vscode.commands.registerCommand("git-ai-kiro.removeHooks", () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders) return;
      for (const folder of folders) removeHooksForFolder(folder.uri.fsPath);
      vscode.window.showInformationMessage("git-ai hooks 已从工作区移除");
    })
  );

  // 核心：监听文件保存，在 AI 活跃窗口内触发 ai_agent checkpoint
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      // 只在 AI 活跃窗口内触发 ai_agent checkpoint
      if (checkpointManager.isAiActive()) {
        checkpointManager.scheduleAiCheckpoint([doc.uri.fsPath]);
      }
    })
  );

  // 新文件创建也触发（AI 活跃窗口内）
  context.subscriptions.push(
    vscode.workspace.onDidCreateFiles((event) => {
      if (!checkpointManager.isAiActive()) return;
      const paths = event.files
        .filter((u) => u.scheme === "file")
        .map((u) => u.fsPath);
      if (paths.length > 0) {
        checkpointManager.scheduleAiCheckpoint(paths);
      }
    })
  );

  // 清理
  context.subscriptions.push({ dispose: () => checkpointManager.dispose() });

  console.log("[git-ai-kiro] 插件就绪");
}

export function deactivate() {
  console.log("[git-ai-kiro] 插件停用");
}
