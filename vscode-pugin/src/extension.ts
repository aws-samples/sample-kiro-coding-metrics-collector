import * as vscode from "vscode";
import { AIEditManager } from "./ai-edit-manager";
import { detectIDEHost } from "./utils/host-kind";
import { BlameLensManager, registerBlameLensCommands } from "./blame-lens-manager";
import { initBinaryResolver } from "./utils/binary-path";
import { CommitWatcher } from "./commit-watcher";

export function activate(context: vscode.ExtensionContext) {

  initBinaryResolver(context.extensionMode);

  const ideHostCfg = detectIDEHost();

  const aiEditManager = new AIEditManager(context);

  // Initialize and activate blame lens manager
  registerBlameLensCommands(context);
  const blameLensManager = new BlameLensManager(context);
  blameLensManager.activate();
  context.subscriptions.push({
    dispose: () => blameLensManager.dispose()
  });

  console.log('[git-ai] ideHostCfg.kind:',ideHostCfg.kind) 
  // 始终注册事件监听器（Kiro 需要通过 Kiro Logs 检测 AI 编辑）
  console.log('[git-ai] Registering event listeners for AI edit detection (Kiro + Copilot)');

  // Save event
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      aiEditManager.handleSaveEvent(doc);
    })
  );

  // Open event
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      aiEditManager.handleOpenEvent(doc);
    })
  );

  // Close event
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      aiEditManager.handleCloseEvent(doc);
    })
  );

  // Content change event (for stable content cache AND Kiro Logs AI detection)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      aiEditManager.handleContentChangeEvent(event);
    })
  );

  // Start commit watcher to upload stats on every git commit
  const commitWatcher = new CommitWatcher();
  commitWatcher.start();
  context.subscriptions.push(commitWatcher);
  

  // vscode.commands.getCommands(true)
  //   .then(commands => {
  //     const content = commands.join('\n');
  //     vscode.workspace.openTextDocument({ content, language: 'text' })
  //       .then(doc => vscode.window.showTextDocument(doc));
  //   });
}

export function deactivate() {
  console.log('[git-ai] extension deactivated');
}
