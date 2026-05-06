# Implementation Plan: Repo-Aware Checkpoint Routing

## Overview

Implement repo-aware checkpoint routing for the Kiro VS Code extension so that multi-repo workspaces produce per-repository checkpoint payloads with correct repo-relative paths. The approach is:

1. Update related documentation (README, module diagrams, design decisions)
2. Create a pure-function `repoRouter.ts` module with path normalization, longest-prefix repo matching, and action grouping
3. Validate the pure functions with property-based tests (6 correctness properties from the design)
4. Integrate repo discovery and per-repo dispatch into `SessionLogWatcher`
5. Add unit tests for integration concerns (git API mocking, dispatch ordering, error handling)

## Tasks

- [x] 1. Update related documentation
  - **注意：README.md 以中文为主，所有新增和修改的内容务必使用中文撰写。**
  - [x] 1.1 Update `agent-support/kiro/README.md` — document multi-repo workspace support
    - In the "使用方法" section, add a note that the extension now supports multi-repo workspaces (a parent directory containing multiple git repos)
    - In the "工作原理 → 模块依赖关系" mermaid diagram, add `repoRouter.ts` as a new dependency of `sessionLogWatcher.ts`
    - In the "工作原理 → 端到端流程" section, update the sequence diagram to show per-repo checkpoint dispatch
    - In the "项目结构" section, add `repoRouter.ts` with a brief description
    - In the "已知问题" section, remove or update the multi-repo attribution issue if it is now resolved
    - In the "限制" section, add a note about dependency on VS Code git extension API for repo discovery
  - [x] 1.2 Update `agent-support/kiro/README.md` — update key design decisions
    - In the "关键设计决策" section, add a bullet about repo-aware checkpoint routing: the extension discovers git repos via VS Code git extension API, groups write actions by repo, and sends per-repo checkpoints with cwd set to the repo directory
    - Mention backward compatibility: single-repo workspaces produce identical behavior to the previous implementation

- [x] 2. Create `repoRouter.ts` — pure-function module for repo routing
  - [x] 2.1 Define interfaces and implement `normalizePath` and `ensureTrailingSlash`
    - Create `agent-support/kiro/src/repoRouter.ts`
    - Define `RepoInfo` and `RepoActionGroup` interfaces
    - Implement `normalizePath(p: string): string` — replace backslashes with forward slashes
    - Implement `ensureTrailingSlash(p: string): string` — append `/` if not present
    - Import `WriteAction` type from `workspacePathEncoder.ts`
    - _Requirements: 7.1, 7.3_

  - [x] 2.2 Implement `findRepoForFile` — longest-prefix repository matching
    - Implement `findRepoForFile(absoluteFilePath, repos): RepoInfo | null`
    - Normalize all paths before comparison
    - Use `ensureTrailingSlash` on repo roots for correct prefix matching
    - Return the repo with the longest matching `rootPath` prefix, or `null` if none match
    - _Requirements: 2.1, 2.2_

  - [x] 2.3 Implement `toRepoRelativePath` — workspace-relative to repo-relative conversion
    - Implement `toRepoRelativePath(workspaceRelativePath, workspacePath, repoPath): string`
    - Resolve workspace-relative path to absolute, then strip the repo root prefix
    - Normalize result to forward slashes, ensure no leading separator
    - _Requirements: 3.1, 7.1, 7.2_

  - [x] 2.4 Implement `groupActionsByRepo` — group WriteActions by owning repository
    - Implement `groupActionsByRepo(actions, repos, workspacePath): { groups: RepoActionGroup[]; orphans: WriteAction[] }`
    - For each action: resolve to absolute path, find repo via `findRepoForFile`, convert to repo-relative
    - Collect orphans (actions matching no repo) separately
    - Return one `RepoActionGroup` per repo that has matching actions
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 3. Property-based tests for `repoRouter.ts`
  - [x] 3.1 Write property test: Grouping assigns each action to the longest-prefix repository
    - **Property 1: Grouping assigns each action to the longest-prefix repository**
    - Generate nested repo sets and WriteActions under specific repos
    - Verify each action lands in the group for the repo with the longest matching prefix
    - **Validates: Requirements 2.1, 2.2, 2.4**

  - [x] 3.2 Write property test: Orphan exclusion
    - **Property 2: Orphan exclusion**
    - Generate WriteActions with paths outside all repo roots
    - Verify orphan actions appear in the orphans list and not in any group
    - **Validates: Requirements 2.3**

  - [x] 3.3 Write property test: Partition completeness
    - **Property 3: Partition completeness**
    - Generate arbitrary repos and actions
    - Verify total grouped actions + orphans equals original action count
    - Verify no action appears in more than one group
    - **Validates: Requirements 2.1, 2.3**

  - [x] 3.4 Write property test: Path conversion round-trip
    - **Property 4: Path conversion round-trip**
    - Generate workspace paths, repo paths (prefix of workspace or subdirectory), and file paths under the repo
    - Verify: resolve(repoPath, toRepoRelativePath(wsRelPath, wsPath, repoPath)) === resolve(wsPath, wsRelPath)
    - **Validates: Requirements 3.1, 7.4**

  - [x] 3.5 Write property test: Single-repo identity
    - **Property 5: Single-repo identity**
    - Generate cases where workspace root === repo root
    - Verify toRepoRelativePath returns the original workspace-relative path unchanged
    - **Validates: Requirements 3.4, 5.1, 5.3**

  - [x] 3.6 Write property test: Output path format invariants
    - **Property 6: Output path format invariants**
    - Generate arbitrary valid path conversions
    - Verify result contains only forward slashes (no backslashes) and does not start with `/` or `\`
    - **Validates: Requirements 7.1, 7.2**

- [x] 4. Checkpoint — Verify repoRouter pure functions
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Integrate repo discovery into `SessionLogWatcher`
  - [x] 5.1 Add git extension API discovery to `SessionLogWatcher`
    - Add `repos: RepoInfo[]` and `gitApiDisposable` fields to the class
    - Implement `initRepoDiscovery()` method following the `CommitWatcher.start()` pattern
    - Query `vscode.extensions.getExtension("vscode.git")` for repositories
    - Map each `repo.rootUri.fsPath` to a `RepoInfo`
    - Subscribe to `onDidOpenRepository` to track new repos
    - Fall back to `[{ rootPath: this.workspacePath }]` if git API is unavailable
    - Log `[git-ai-kiro]` warning when falling back
    - Call `initRepoDiscovery()` from `start()`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 6.1, 6.2, 6.3_

  - [x] 5.2 Modify `processExecutionLog` for per-repo dispatch
    - Import `groupActionsByRepo`, `toRepoRelativePath` from `repoRouter.ts`
    - After filtering new actions, call `groupActionsByRepo(newActions, this.repos, this.workspacePath)`
    - Log orphan files with `[git-ai-kiro]` prefix
    - For each `RepoActionGroup`: build human payload with repo-relative paths and `repo_working_dir` = repoPath, then send human checkpoint with `cwd` = repoPath, then build AI payload via `buildCheckpointPayload(repoPath, repoActions)`, then send AI checkpoint with `cwd` = repoPath
    - Continue processing remaining repos if one fails
    - Update `buildHumanPayload` to accept a `repoPath` parameter for `repo_working_dir`
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 8.1, 8.2_

  - [x] 5.3 Clean up git API subscription in `dispose()`
    - Dispose `gitApiDisposable` in the `dispose()` method
    - _Requirements: 1.2_

- [x] 6. Checkpoint — Verify integration compiles and existing tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Unit tests for integration concerns
  - [x] 7.1 Write unit tests for git extension API discovery
    - Test: git API available → repos populated from `git.repositories`
    - Test: git API unavailable → falls back to workspace root
    - Test: `onDidOpenRepository` adds new repo to tracked set
    - Test: deferred initialization (API not active at start, becomes active later)
    - Mock `vscode.extensions.getExtension` and git API
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 6.1, 6.2, 6.3_

  - [x] 7.2 Write unit tests for per-repo checkpoint dispatch
    - Test: multi-repo workspace dispatches separate checkpoint calls per repo
    - Test: human + AI checkpoint ordering per repo (human first, then AI)
    - Test: `cwd` parameter is set to repo path, not workspace path
    - Test: `repo_working_dir` in payload is set to repo path
    - Test: single-repo workspace produces identical behavior to current implementation
    - Test: per-repo failure continues processing remaining repos
    - _Requirements: 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2_

- [x] 8. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 6 correctness properties defined in the design document
- Unit tests validate integration concerns that require mocking VS Code APIs
- `checkpointPayload.ts` requires no code changes — the `workspacePath` parameter is already semantically a "base path"
- `extension.ts` requires no changes — `SessionLogWatcher` handles git API access internally
