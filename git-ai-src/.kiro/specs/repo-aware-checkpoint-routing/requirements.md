# Requirements Document

## Introduction

The Kiro VS Code extension's `SessionLogWatcher` currently sends checkpoint data to the `git-ai` binary using workspace-relative file paths and the workspace root as the working directory. This works when the workspace itself is a git repository, but breaks in multi-repo workspaces (a parent directory containing multiple git repos like `dummy-project1/` and `dummy-project2/`).

The root cause is a path key mismatch: `edited_filepaths` get converted to repo-relative paths by git-ai's multi-repo detection, but `dirty_files` keys remain workspace-relative. This causes git-ai to ignore the provided `dirty_files` content and fall back to reading from disk, where the human checkpoint arrives first and attributes AI-written code as human-written.

This feature makes the extension repo-aware: it discovers git repositories via VS Code's built-in git extension API, groups write actions by repository, converts paths to repo-relative, and sends per-repo checkpoints with `cwd` set to the repo directory. This bypasses git-ai's multi-repo detection entirely, ensuring consistent paths in all payload fields.

## Glossary

- **SessionLogWatcher**: The VS Code extension component that monitors Kiro execution log directories for changes, parses write actions, and sends checkpoint payloads to git-ai. Defined in `sessionLogWatcher.ts`.
- **Git_Extension_API**: The VS Code built-in git extension (`vscode.git`) that provides access to discovered git repositories in the workspace. Already used by `CommitWatcher`.
- **Repository**: A git repository discovered by the Git_Extension_API, identified by its `rootUri.fsPath` absolute path.
- **WriteAction**: A record representing a single AI file write operation, containing `filePath` (workspace-relative), `actionType`, `originalContent`, `modifiedContent`, and `emittedAt`. Defined in `workspacePathEncoder.ts`.
- **Workspace_Root**: The absolute path of the first VS Code workspace folder, passed to `SessionLogWatcher` at construction time.
- **Repo_Relative_Path**: A file path relative to a git repository root, as opposed to a workspace-relative path. For example, `test1.js` instead of `dummy-project1/test1.js`.
- **Checkpoint_Payload**: The JSON object sent to `callCheckpointAgentV1`, containing `type`, `repo_working_dir`, `edited_filepaths`, `dirty_files`, and other fields. Defined as `AICheckpointPayload` in `workspacePathEncoder.ts`.
- **Orphan_File**: A file referenced in a WriteAction whose path does not fall under any discovered git repository.
- **Single_Repo_Workspace**: A workspace where the Workspace_Root itself is a git repository root (the common case).
- **Multi_Repo_Workspace**: A workspace where the Workspace_Root is not a git repository, but contains one or more git repositories as subdirectories.

## Requirements

### Requirement 1: Git Repository Discovery

**User Story:** As a developer using Kiro in a multi-repo workspace, I want the extension to discover all git repositories in my workspace, so that checkpoint data is routed to the correct repository.

#### Acceptance Criteria

1. WHEN the SessionLogWatcher starts, THE SessionLogWatcher SHALL query the Git_Extension_API for all currently known repositories.
2. WHEN the Git_Extension_API reports a new repository after initial startup, THE SessionLogWatcher SHALL add the new Repository to its tracked set.
3. IF the Git_Extension_API is not available or not active, THEN THE SessionLogWatcher SHALL fall back to treating the Workspace_Root as the sole Repository root.
4. WHEN no repositories are discovered and the Git_Extension_API is unavailable, THE SessionLogWatcher SHALL log a warning message with the prefix `[git-ai-kiro]` and continue operating with the Workspace_Root as the working directory.

### Requirement 2: WriteAction-to-Repository Grouping

**User Story:** As a developer, I want each write action to be associated with the correct git repository, so that checkpoint payloads contain only files belonging to that repository.

#### Acceptance Criteria

1. WHEN a list of WriteActions is processed, THE SessionLogWatcher SHALL group each WriteAction by the Repository whose `rootUri.fsPath` is a prefix of the WriteAction's absolute file path.
2. WHEN multiple repositories could match a WriteAction's file path (nested repos), THE SessionLogWatcher SHALL assign the WriteAction to the Repository with the longest matching prefix.
3. IF a WriteAction's file path does not fall under any discovered Repository, THEN THE SessionLogWatcher SHALL skip the Orphan_File and log a warning with the prefix `[git-ai-kiro]` that includes the file path.
4. WHEN a single execution log contains WriteActions spanning multiple repositories, THE SessionLogWatcher SHALL produce separate groups for each Repository.

### Requirement 3: Path Conversion to Repo-Relative

**User Story:** As a developer, I want file paths in checkpoint payloads to be relative to the git repository root, so that git-ai receives consistent paths in all payload fields.

#### Acceptance Criteria

1. WHEN building a Checkpoint_Payload for a Repository, THE SessionLogWatcher SHALL convert each WriteAction `filePath` from workspace-relative to Repo_Relative_Path by removing the repository prefix from the absolute path.
2. THE SessionLogWatcher SHALL use Repo_Relative_Path values for both `edited_filepaths` entries and `dirty_files` keys within the same Checkpoint_Payload.
3. THE SessionLogWatcher SHALL set the `repo_working_dir` field of the Checkpoint_Payload to the Repository's absolute path.
4. WHEN the Workspace_Root is the same as the Repository root (Single_Repo_Workspace), THE SessionLogWatcher SHALL produce paths identical to the current behavior (no transformation needed).

### Requirement 4: Per-Repository Checkpoint Dispatch

**User Story:** As a developer, I want checkpoint calls to use the git repository directory as the working directory, so that git-ai processes each checkpoint within the correct repository context.

#### Acceptance Criteria

1. WHEN sending a Checkpoint_Payload to `callCheckpointAgentV1`, THE SessionLogWatcher SHALL pass the Repository's absolute path as the `cwd` parameter instead of the Workspace_Root.
2. WHEN an execution log produces WriteAction groups for multiple repositories, THE SessionLogWatcher SHALL call `callCheckpointAgentV1` separately for each Repository's group.
3. WHEN an execution log produces WriteAction groups for multiple repositories, THE SessionLogWatcher SHALL send the human checkpoint and AI checkpoint pair for each Repository before proceeding to the next Repository.
4. IF a per-repository checkpoint call fails, THEN THE SessionLogWatcher SHALL log the error and continue processing the remaining repositories.

### Requirement 5: Single-Repo Workspace Backward Compatibility

**User Story:** As a developer using Kiro in a standard single-repo workspace, I want the checkpoint behavior to remain identical to the current implementation, so that there is no regression.

#### Acceptance Criteria

1. WHEN the Workspace_Root is a git repository root (Single_Repo_Workspace), THE SessionLogWatcher SHALL produce checkpoint payloads with the same `cwd`, `edited_filepaths`, `dirty_files` keys, and `repo_working_dir` values as the current implementation.
2. WHEN only one Repository is discovered and its root matches the Workspace_Root, THE SessionLogWatcher SHALL call `callCheckpointAgentV1` exactly once per execution log (same as current behavior).
3. WHEN the Workspace_Root is a git repository root, THE SessionLogWatcher SHALL use workspace-relative paths without any transformation (preserving current path format).

### Requirement 6: Deferred Git Extension Initialization

**User Story:** As a developer, I want the extension to handle the case where the VS Code git extension is not yet initialized when SessionLogWatcher starts, so that repositories are still discovered once available.

#### Acceptance Criteria

1. IF the Git_Extension_API is not active when the SessionLogWatcher starts, THEN THE SessionLogWatcher SHALL use the Workspace_Root as the initial Repository root and log a message indicating deferred initialization.
2. WHEN the Git_Extension_API becomes active after deferred initialization, THE SessionLogWatcher SHALL update its tracked repositories from the Git_Extension_API.
3. WHILE the Git_Extension_API is not yet active, THE SessionLogWatcher SHALL continue processing execution logs using the Workspace_Root as the working directory.

### Requirement 7: Path Conversion Correctness

**User Story:** As a developer, I want path conversion to handle edge cases correctly, so that checkpoint payloads always contain valid repo-relative paths.

#### Acceptance Criteria

1. THE SessionLogWatcher SHALL normalize path separators to forward slashes in Repo_Relative_Path values on all platforms.
2. WHEN converting a workspace-relative path to a Repo_Relative_Path, THE SessionLogWatcher SHALL produce a path that does not start with a path separator.
3. WHEN the Repository root path and the file's absolute path use different path separator styles (mixed slashes on Windows), THE SessionLogWatcher SHALL still produce a correct Repo_Relative_Path.
4. FOR ALL valid WriteAction file paths within a discovered Repository, converting to Repo_Relative_Path and then resolving against the Repository root SHALL produce the same absolute path as resolving the original workspace-relative path against the Workspace_Root (round-trip property).

### Requirement 8: buildCheckpointPayload Repo-Awareness

**User Story:** As a developer, I want the checkpoint payload builder to accept a repository path instead of a workspace path, so that file reads for Format B fallback use the correct base directory.

#### Acceptance Criteria

1. WHEN `buildCheckpointPayload` reads a file from disk for Format B fallback (no `originalContent`), THE `buildCheckpointPayload` function SHALL resolve the file path against the provided repository path, not the Workspace_Root.
2. THE `buildCheckpointPayload` function SHALL set `repo_working_dir` to the provided repository path.
3. WHEN called with a repository path equal to the Workspace_Root, THE `buildCheckpointPayload` function SHALL produce identical output to the current implementation.
