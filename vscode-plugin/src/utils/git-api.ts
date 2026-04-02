import * as vscode from "vscode";
import * as path from "node:path";

// Git 仓库的最小类型定义
export interface GitRepository {
  rootUri: vscode.Uri;
  state: { HEAD?: { commit?: string } };
}

// 获取 VSCode 内置 Git 扩展 API
function getGitAPI() {
  return vscode.extensions
    .getExtension("vscode.git")
    ?.exports.getAPI(1) as { repositories: GitRepository[] } | undefined;
}

// 查找文件所属的 Git 仓库
export function findRepoForFile(fileUri: vscode.Uri): GitRepository | undefined {
  const git = getGitAPI();
  if (!git) return undefined;

  const filePath = fileUri.fsPath;
  return git.repositories
    .filter((r) => {
      const root = r.rootUri.fsPath;
      return filePath === root || filePath.startsWith(root + path.sep);
    })
    .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
}

// 获取文件所在 Git 仓库的根目录
export function getGitRepoRoot(fileUri: vscode.Uri): string | null {
  return findRepoForFile(fileUri)?.rootUri.fsPath ?? null;
}
