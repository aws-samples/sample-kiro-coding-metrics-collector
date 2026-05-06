# 需求文档

## 简介

当前 `agent-support/kiro` VS Code 插件通过修改 `git.path` 配置，将其指向 git-ai 的 shim（符号链接），使所有 git 操作经过 git-ai 代理。这样做的核心目的是让 git-ai 的 post-commit hook 能在用户提交时自动将 working log 转换为 Git Notes（authorship note）。

然而，修改用户的 `git.path` 是一个敏感操作，可能导致用户困惑、与其他插件冲突、或在插件卸载后残留错误配置。

本功能的目标是：移除对 `git.path` 的修改，改为通过插件内部监听 git 仓库变化（HEAD 变化）来检测 commit 事件，然后主动调用 git-ai 二进制执行 post-commit 处理，完成 working log 到 authorship note 的转换。

## 术语表

- **Extension**: `agent-support/kiro` 目录下的 VS Code/Kiro 插件，即 `git-ai-kiro` 扩展
- **Git_Shim**: 当前实现中，在 `bin/` 目录下创建的名为 `git` 的符号链接（Unix）或副本（Windows），指向 git-ai 二进制，使 argv[0] 为 "git" 以激活代理模式
- **Git_Path_Override**: 插件通过 `vscode.workspace.getConfiguration("git").update("path", ...)` 将 `git.path` 设置为 Git_Shim 路径的行为
- **CommitWatcher**: 插件中已有的类，通过 `vscode.git` 扩展 API 监听 HEAD 变化来检测新的 commit
- **Git_AI_Binary**: 打包在插件 `bin/` 目录中的 git-ai 可执行文件，当 argv[0] 为 "git-ai" 时进入直接命令模式
- **Post_Commit_Processing**: git-ai 的 post-commit 逻辑，读取 working log 并生成 authorship note（Git Notes under `refs/notes/ai`）
- **Working_Log**: 存储在 `.git/ai/working_logs/<base_commit>/` 中的 JSON 文件，记录每个文件的逐行 AI/人类归属信息
- **Authorship_Note**: 存储在 `refs/notes/ai` 命名空间下的 Git Note，包含 commit 级别的 AI 归属数据
- **Rewrite_Log**: 存储在 `.git/ai/rewrite_log` 中的日志，记录 rebase、cherry-pick 等历史重写操作，用于 authorship note 的重写追踪

## 需求

### 需求 1：移除 git.path 修改逻辑

**用户故事：** 作为开发者，我希望插件不再修改我的 `git.path` 配置，以避免对我的 git 环境产生侵入性影响。

#### 验收标准

1. THE Extension SHALL NOT modify the `git.path` VS Code configuration setting during activation or at any point during its lifecycle
2. THE Extension SHALL NOT create a Git_Shim (symlink or copy named "git") in the `bin/` directory
3. WHEN the Extension activates, THE Extension SHALL initialize the Git_AI_Binary without creating any git proxy shim
4. THE Extension SHALL retain the Git_AI_Binary initialization logic (quarantine removal, chmod) for direct invocation use

### 需求 2：通过 CommitWatcher 触发 Post-Commit 处理

**用户故事：** 作为开发者，我希望插件能在我提交 commit 后自动完成 authorship note 的生成，而不依赖 git.path 代理机制。

#### 验收标准

1. WHEN the CommitWatcher detects a new local commit (HEAD change with reflog prefix "commit"), THE Extension SHALL invoke the Git_AI_Binary to execute Post_Commit_Processing for the detected commit
2. WHEN the CommitWatcher triggers Post_Commit_Processing, THE Extension SHALL pass the repository working directory and the commit SHA to the Git_AI_Binary
3. WHEN Post_Commit_Processing completes successfully, THE Extension SHALL log the success and proceed with stats upload
4. IF Post_Commit_Processing fails, THEN THE Extension SHALL log the error and still proceed with stats upload (non-blocking)
5. THE Extension SHALL execute Post_Commit_Processing before stats upload, so that the authorship note is available when stats are queried

### 需求 3：确定 git-ai 二进制的 Post-Commit 调用方式

**用户故事：** 作为开发者，我希望插件能通过 git-ai 二进制的直接命令模式触发 post-commit 逻辑，而不需要 git 代理模式。

#### 验收标准

1. THE Extension SHALL invoke the Git_AI_Binary using its native binary name (argv[0] = "git-ai"), not through the git proxy shim
2. WHEN invoking Post_Commit_Processing, THE Extension SHALL use the `git-hooks` subcommand or an equivalent direct subcommand that triggers the post-commit authorship note generation
3. IF the Git_AI_Binary does not currently support a direct post-commit subcommand, THEN the Rust codebase SHALL be extended to add such a subcommand (e.g., `git-ai post-commit` or `git-ai git-hooks post-commit`)
4. WHEN the direct post-commit subcommand is invoked, THE Git_AI_Binary SHALL read the Working_Log for the specified commit and generate the Authorship_Note, identical to the behavior of the git proxy post-commit hook

### 需求 4：移除 statsUploader 中的延迟等待机制

**用户故事：** 作为开发者，我希望 stats 上传不再需要盲目等待 post-commit hook 完成，因为插件现在能主动控制 post-commit 的执行时序。

#### 验收标准

1. THE CommitWatcher SHALL execute Post_Commit_Processing synchronously (await completion) before triggering stats upload
2. THE Extension SHALL remove the `POST_COMMIT_DELAY_MS` (3 秒延迟) from the CommitWatcher, because Post_Commit_Processing is now explicitly sequenced before stats upload
3. THE statsUploader SHALL retain its retry logic for querying commit stats, as a fallback for edge cases where the authorship note write may be delayed

### 需求 5：保持 AIEditManager checkpoint 功能不变

**用户故事：** 作为开发者，我希望 AI 编辑的 checkpoint（working log 写入）功能不受此次重构影响。

#### 验收标准

1. THE AIEditManager SHALL continue to call `callCheckpointAgentV1` to write Working_Log entries when AI edits are detected, using the Git_AI_Binary directly (argv[0] = "git-ai")
2. THE Extension SHALL NOT change the checkpoint invocation mechanism, as it already uses the Git_AI_Binary directly without depending on the git proxy shim

### 需求 6：清理残留的 git.path 配置

**用户故事：** 作为开发者，我希望插件升级后能自动清理之前版本设置的 `git.path`，避免残留配置导致 git 操作异常。

#### 验收标准

1. WHEN the Extension activates, THE Extension SHALL check if the current `git.path` configuration points to a path within the Extension's `bin/` directory
2. IF `git.path` points to the Extension's `bin/` directory, THEN THE Extension SHALL reset `git.path` to its default value (undefined/empty)
3. WHEN the Extension resets `git.path`, THE Extension SHALL log a message indicating the cleanup action
4. IF `git.path` points to a path outside the Extension's `bin/` directory, THEN THE Extension SHALL NOT modify `git.path` (respect user's custom configuration)

### 需求 7：跨平台兼容性

**用户故事：** 作为开发者，我希望新的实现在 macOS、Linux 和 Windows 上都能正常工作。

#### 验收标准

1. THE Extension SHALL invoke the Git_AI_Binary using the platform-appropriate binary name (`git-ai` on Unix, `git-ai.exe` on Windows)
2. THE Extension SHALL handle path separators correctly on all supported platforms when passing repository paths to the Git_AI_Binary
3. WHEN the Extension detects a commit on Windows, THE Extension SHALL use the same CommitWatcher mechanism (vscode.git API) as on Unix platforms
