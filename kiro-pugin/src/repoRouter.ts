/**
 * RepoRouter — pure-function module for routing WriteActions to git repositories.
 *
 * All functions are pure (no I/O, no VS Code API dependencies) and never throw.
 * Path operations use forward-slash normalization for cross-platform consistency.
 */

import type { WriteAction } from "./workspacePathEncoder.js";
import * as path from "node:path";

// ── Interfaces ───────────────────────────────────────────────────────

/** A discovered git repository with its absolute root path. */
export interface RepoInfo {
  /** Absolute path to the repository root (forward-slash normalized). */
  rootPath: string;
}

/** Result of grouping WriteActions by repository. */
export interface RepoActionGroup {
  /** Absolute path to the repository root. */
  repoPath: string;
  /** WriteActions with filePath converted to repo-relative. */
  actions: WriteAction[];
}

// ── Utility Functions ────────────────────────────────────────────────

/**
 * Normalize a file path to use forward slashes consistently.
 * Handles Windows backslashes and mixed separators.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Ensure a path ends with a trailing forward slash for prefix matching.
 * If the path already ends with '/', returns it unchanged.
 */
export function ensureTrailingSlash(p: string): string {
  return p.endsWith("/") ? p : p + "/";
}

// ── Repo Matching ────────────────────────────────────────────────────

/**
 * Find the repository whose root is the longest prefix of the given absolute file path.
 * Returns null if no repository matches.
 *
 * @param absoluteFilePath - Absolute path to the file (forward-slash normalized)
 * @param repos - List of discovered repositories
 * @returns The matching RepoInfo, or null if no match
 */
export function findRepoForFile(
  absoluteFilePath: string,
  repos: RepoInfo[]
): RepoInfo | null {
  // Windows 上文件系统是大小写不敏感的。归一化路径后统一小写做前缀比较，
  // 避免盘符大小写差异（D: vs d:）导致匹配失败。
  const isWindows = process.platform === "win32";
  const normalizedFile = normalizePath(absoluteFilePath);
  const fileForCompare = isWindows ? normalizedFile.toLowerCase() : normalizedFile;
  let bestMatch: RepoInfo | null = null;
  let bestLength = 0;

  for (const repo of repos) {
    const normalizedRoot = ensureTrailingSlash(normalizePath(repo.rootPath));
    const rootForCompare = isWindows ? normalizedRoot.toLowerCase() : normalizedRoot;
    if (
      fileForCompare.startsWith(rootForCompare) &&
      normalizedRoot.length > bestLength
    ) {
      bestMatch = repo;
      bestLength = normalizedRoot.length;
    }
  }

  return bestMatch;
}

// ── Path Conversion ──────────────────────────────────────────────────

/**
 * Convert a workspace-relative file path to a repo-relative file path.
 *
 * @param workspaceRelativePath - File path relative to workspace root
 * @param workspacePath - Absolute path to workspace root
 * @param repoPath - Absolute path to repository root
 * @returns File path relative to repository root (forward-slash, no leading separator)
 */
export function toRepoRelativePath(
  workspaceRelativePath: string,
  workspacePath: string,
  repoPath: string
): string {
  // Resolve workspace-relative path to absolute (handles ../ correctly)
  const absolutePath = normalizePath(
    path.resolve(workspacePath, workspaceRelativePath)
  );

  // Strip the repo root prefix (with trailing slash) from the absolute path.
  // Windows 上做大小写不敏感的前缀匹配（盘符大小写可能不一致）。
  const isWindows = process.platform === "win32";
  const normalizedRepoRoot = ensureTrailingSlash(normalizePath(repoPath));
  const absForCompare = isWindows ? absolutePath.toLowerCase() : absolutePath;
  const rootForCompare = isWindows ? normalizedRepoRoot.toLowerCase() : normalizedRepoRoot;
  const repoRelative = absForCompare.startsWith(rootForCompare)
    ? absolutePath.slice(normalizedRepoRoot.length)
    : absolutePath;

  // Ensure no leading separator
  return repoRelative.replace(/^\/+/, "");
}

// ── Action Grouping ──────────────────────────────────────────────────

/**
 * Group WriteActions by their owning repository.
 *
 * For each WriteAction:
 * 1. Resolve workspace-relative filePath to absolute path
 * 2. Find the repo with the longest matching prefix
 * 3. Convert filePath to repo-relative
 * 4. Add to the repo's group
 *
 * Actions that don't match any repo are collected as orphans.
 *
 * @param actions - WriteActions with workspace-relative filePaths
 * @param repos - Discovered repositories
 * @param workspacePath - Absolute workspace root path
 * @returns Object with `groups` (one RepoActionGroup per repo with matching actions) and `orphans` (actions matching no repo)
 */
export function groupActionsByRepo(
  actions: WriteAction[],
  repos: RepoInfo[],
  workspacePath: string
): { groups: RepoActionGroup[]; orphans: WriteAction[] } {
  const groupMap = new Map<string, WriteAction[]>();
  const orphans: WriteAction[] = [];

  for (const action of actions) {
    // 1. Resolve workspace-relative filePath to absolute (handles ../ paths correctly)
    const absolutePath = normalizePath(
      path.resolve(workspacePath, action.filePath)
    );

    // 2. Find the repo with the longest matching prefix
    const repo = findRepoForFile(absolutePath, repos);

    if (repo === null) {
      // No matching repo — collect as orphan
      orphans.push(action);
      continue;
    }

    // 3. Convert filePath to repo-relative
    const repoRelativePath = toRepoRelativePath(
      action.filePath,
      workspacePath,
      repo.rootPath
    );

    // 4. Add to the repo's group with repo-relative filePath
    const normalizedRoot = normalizePath(repo.rootPath);
    let group = groupMap.get(normalizedRoot);
    if (!group) {
      group = [];
      groupMap.set(normalizedRoot, group);
    }
    group.push({ ...action, filePath: repoRelativePath });
  }

  // Build one RepoActionGroup per repo that has matching actions
  const groups: RepoActionGroup[] = [];
  for (const [repoPath, repoActions] of groupMap) {
    groups.push({ repoPath, actions: repoActions });
  }

  return { groups, orphans };
}
