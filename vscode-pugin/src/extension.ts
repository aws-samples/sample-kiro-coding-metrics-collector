import * as vscode from "vscode";
import { AIEditManager } from "./ai-edit-manager";
import { CommitWatcher } from "./commit-watcher";

export function activate(context: vscode.ExtensionContext) {
  console.log("[kiro-ai-coverage] Activating extension");

  const aiEditManager = new AIEditManager(context);

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

  console.log("[kiro-ai-coverage] Extension activated");
}

export function deactivate() {
  console.log("[kiro-ai-coverage] Extension deactivated");
}
