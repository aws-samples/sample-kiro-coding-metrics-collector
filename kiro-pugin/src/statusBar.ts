import * as vscode from "vscode";

export type StatusBarState =
  | "watching"
  | "checkpointing"
  | "success"
  | "failure"
  | "inactive";

const LABELS: Record<StatusBarState, string> = {
  watching: "git-ai: 监听中",
  checkpointing: "git-ai: 更新中",
  success: "git-ai: 更新成功",
  failure: "git-ai: 更新失败",
  inactive: "git-ai: 未激活",
};

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private revertTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      0
    );
    this.setState("inactive");
    this.item.show();
  }

  setState(state: StatusBarState): void {
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }

    this.item.text = LABELS[state];

    if (state === "success" || state === "failure") {
      this.revertTimer = setTimeout(() => {
        this.revertTimer = null;
        this.item.text = LABELS.watching;
      }, 2000);
    }
  }

  dispose(): void {
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
    }
    this.item.dispose();
  }
}
