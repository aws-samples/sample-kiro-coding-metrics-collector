# 实施计划：移除 git.path 覆盖

## 概述

将 `git-ai-kiro` 插件从 git 代理模式迁移到直接调用模式。分为四个阶段：Rust 端新增 `post-commit` 子命令、TypeScript 端移除 shim/git.path 逻辑、TypeScript 端改造 CommitWatcher 流程、清理与集成验证。

## 任务

- [x] 1. Rust 端：新增 `git-ai post-commit` 子命令
  - [x] 1.1 在 `src/commands/git_ai_handlers.rs` 的 `handle_git_ai` match 中新增 `"post-commit"` 分支
    - 新增 `handle_post_commit(args: &[String])` 函数
    - 从 `args[0]` 获取 commit SHA，缺失时输出用法提示并 `exit(1)`
    - 通过 `find_repository(&[])` 从 cwd 发现仓库
    - 通过 `git rev-parse <commit>^` 获取父 commit SHA（初始 commit 时设为 `None`）
    - 通过 `repo.git_commit_author_identity()` 获取作者信息，格式化为 `"name <email>"`
    - 先调用 `pre_commit::pre_commit(&repo, author)` 捕获 AI session 结束后的人类编辑（commit 后工作目录内容与已提交内容一致，时机正确）
    - 调用 `repo.handle_rewrite_log_event(RewriteLogEvent::commit(base_commit, commit_sha), author, true, true)`
    - 失败时输出错误到 stderr 并 `exit(1)`
    - _需求: 3.1, 3.2, 3.3, 3.4_

  - [x] 1.2 为 `handle_post_commit` 编写集成测试
    - 在 `tests/` 目录下创建测试文件
    - 使用 TestRepo 框架创建仓库，写入 working log，执行 `git-ai post-commit <sha>`
    - 验证 authorship note 正确生成
    - 测试缺失 commit SHA 参数时的错误处理
    - 测试初始 commit（无父 commit）场景
    - _需求: 3.4_

- [x] 2. 检查点 - 确保 Rust 端编译通过并测试通过
  - 运行 `cargo build` 和 `cargo clippy` 确保无编译错误和 lint 警告
  - 如有问题请询问用户

- [x] 3. TypeScript 端：移除 shim 创建和 git.path 设置逻辑
  - [x] 3.1 修改 `agent-support/kiro/src/checkpoint.ts`：移除 shim 相关代码
    - 移除 `gitShimPath` 模块级变量
    - 移除 `getGitShimPath()` 导出函数
    - 移除 `initBundledBinary` 中创建 git shim（symlink/copy）的整个代码块（从 `const shimName` 到 `gitShimPath = shimPath` 的 try-catch）
    - 保留 `bundledBinaryPath`、`binaryReady`、quarantine 移除、chmod 逻辑不变
    - _需求: 1.2, 1.3, 1.4_

  - [x] 3.2 修改 `agent-support/kiro/src/extension.ts`：移除 git.path 设置，新增清理逻辑
    - 移除 `getGitShimPath` 的导入
    - 移除 `activate` 函数中设置 `git.path` 的整个代码块（从 `const shimPath = getGitShimPath()` 到对应的 `}` 结束）
    - 新增 `cleanupGitPathOverride(extensionPath: string): void` 函数：
      - 读取当前 `git.path` 配置
      - 检查是否指向插件 `bin/` 目录（使用 `path.normalize` 比较）
      - 如果是，则重置为 `undefined`（`ConfigurationTarget.Global`）并记录日志
      - 如果不是，则不修改
    - 在 `activate` 函数中 `initBundledBinary` 之后调用 `cleanupGitPathOverride(context.extensionPath)`
    - _需求: 1.1, 6.1, 6.2, 6.3, 6.4_


- [x] 4. TypeScript 端：改造 CommitWatcher 流程
  - [x] 4.1 修改 `agent-support/kiro/src/commitWatcher.ts`：新增 `runPostCommit` 并重构 commit 处理流程
    - 移除 `POST_COMMIT_DELAY_MS` 常量
    - 新增 `runPostCommit(repoPath: string, commitSha: string): Promise<boolean>` 函数：
      - 通过 `getGitAiBinary()` 获取二进制路径，不可用时返回 false
      - 使用 `child_process.spawn` 调用 `<binary> post-commit <commitSha>`，cwd 设为 repoPath
      - 收集 stdout/stderr，成功（退出码 0）返回 true，失败返回 false 并记录日志
      - 设置合理超时（如 30 秒）
    - 在 `watchRepository` 的 commit 检测逻辑中：
      - 移除 `setTimeout(POST_COMMIT_DELAY_MS, ...)` 包装
      - 改为异步流程：先 `await runPostCommit(repoPath, currentHead)`，再 `await uploadCommitStats(repoPath, currentHead)`
      - 无论 `runPostCommit` 成功或失败，都执行 `uploadCommitStats`
    - 新增 `import { getGitAiBinary } from "./checkpoint"` 导入
    - _需求: 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.2_

  - [x] 4.2 为 `runPostCommit` 编写属性测试
    - **属性 1: Post-commit 命令参数正确性**
    - **验证: 需求 2.2**

  - [x] 4.3 为 CommitWatcher 的 post-commit → stats 上传顺序编写属性测试
    - **属性 2: Post-commit 先于 stats 上传且容错**
    - **验证: 需求 2.4, 2.5, 4.1**

- [x] 5. 检查点 - 确保 TypeScript 编译通过
  - 在 `agent-support/kiro` 目录下运行 `npm run compile` 确保无编译错误
  - 如有问题请询问用户

- [x] 6. 集成验证与跨平台检查
  - [x] 6.1 验证 `statsUploader.ts` 的 retry 逻辑保持不变
    - 确认 `queryCommitStatsWithRetry` 函数未被修改
    - 确认 `NOTE_RETRY_COUNT` 和 `NOTE_RETRY_DELAY_MS` 常量保留
    - _需求: 4.3_

  - [x] 6.2 验证 `AIEditManager` 的 checkpoint 功能不受影响
    - 确认 `callCheckpointAgentV1` 调用路径未变更
    - 确认 `ai-edit-manager.ts` 无需修改
    - _需求: 5.1, 5.2_

  - [x] 6.3 验证跨平台兼容性
    - 确认 `runPostCommit` 使用 `getGitAiBinary()` 返回的平台适配路径（Unix: `git-ai`, Windows: `git-ai.exe`）
    - 确认路径处理在 Windows 上正确（`path.normalize`）
    - _需求: 7.1, 7.2, 7.3_

  - [x] 6.4 为 `cleanupGitPathOverride` 编写属性测试
    - **属性 4: git.path 清理正确性**
    - **验证: 需求 6.2, 6.4**

- [x] 7. 最终检查点 - 确保所有测试通过
  - 运行 `cargo build` 确保 Rust 端编译通过
  - 在 `agent-support/kiro` 目录下运行 `npm run compile` 确保 TypeScript 编译通过
  - 如有问题请询问用户

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加速 MVP 交付
- 每个任务引用了具体的需求编号以确保可追溯性
- 检查点任务确保增量验证
- 属性测试验证设计文档中定义的正确性属性
- Rust 端使用项目现有的集成测试框架（TestRepo），TypeScript 端可使用 `fast-check`
