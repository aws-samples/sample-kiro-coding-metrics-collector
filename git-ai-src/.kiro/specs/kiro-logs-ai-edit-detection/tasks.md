# 实现计划：Kiro Logs AI 编辑检测

## 概述

将 `agent-support/kiro` 插件的 AI 编辑检测机制从基于 `fs.watch()` 监听执行日志 JSON 文件的方案，重构为基于 Kiro Logs Output Channel 日志事件监听的方案。实现分为：重构 checkpoint.ts 提取公共函数、新建 ai-edit-manager.ts 核心模块、修改 extension.ts 入口、清理旧模块。

## Tasks

- [x] 1. 重构 checkpoint.ts，提取 callCheckpointAgentV1 公共函数
  - [x] 1.1 从 checkpoint.ts 中提取 `callGitAi` 函数为公共导出的 `callCheckpointAgentV1(cwd: string, payload: object): Promise<boolean>`
    - 保持原有的 spawn 逻辑、环境变量设置（`GIT_AI_ASYNC_MODE: "false"`）和错误处理
    - 移除 `runCheckpoint` 函数及其依赖的 `deduplicateEdits`、`toAbsolutePath` 辅助函数
    - 移除 `import type { FileEdit, ParsedExecution } from "./logParser"` 导入
    - 保留 `initBundledBinary`、`getGitAiBinary`、`getGitShimPath`、`isBinaryReady`、`getIgnorePatterns`、`matchesIgnorePattern` 函数不变
    - _需求: 5.1, 8.4_

- [x] 2. 新建 ai-edit-manager.ts 核心模块
  - [x] 2.1 创建 `AIEditManager` 类骨架，包含构造函数、`setStatusBar`、`start`、`dispose` 方法
    - 定义所有内部状态：`kiroAiEditedFiles` Map、`stableFileContent` Map、`stableContentTimers` Map、`pendingSaves` Map、`lastHumanCheckpointAt` Map、`kiroSessionId`、`kiroAgentActive`
    - 定义常量：`KIRO_AI_EDIT_COOLDOWN_MS = 15_000`、`SAVE_EVENT_DEBOUNCE_WINDOW_MS = 300`、`HUMAN_CHECKPOINT_DEBOUNCE_MS = 500`、`STABLE_CONTENT_DEBOUNCE_MS = 2000`
    - `start()` 方法注册四个 VS Code 事件监听器：`onDidChangeTextDocument`、`onDidSaveTextDocument`、`onDidOpenTextDocument`、`onDidCloseTextDocument`
    - `dispose()` 方法清除所有定时器、缓存和事件监听器
    - 导入 `callCheckpointAgentV1`、`isBinaryReady`、`getIgnorePatterns`、`matchesIgnorePattern` 从 `./checkpoint`
    - _需求: 6.1, 6.4, 6.5_

  - [x] 2.2 实现 Kiro Logs Output Channel 日志监听与解析逻辑
    - `handleDocumentChange`: 检查 `document.uri.scheme === "output"` 且 `fsPath` 包含 "Kiro Logs"，分发到 `handleKiroLogsChange`；对 `scheme === "file"` 的文档分发到 stable content 更新逻辑
    - `handleKiroLogsChange`: 遍历 `contentChanges`，解析 `[WriteFile]` 提取文件路径并标记 AI 编辑，解析 `[AgentIterator]` 更新 agent 活跃状态和 session ID，解析 `activeExecution":false` 标记 agent 非活跃
    - `isKiroAiEdited(filePath)`: 检查文件是否在 15 秒窗口内被标记为 AI 编辑，过期则清除
    - 标记 AI 编辑前检查 ignore patterns，匹配则跳过
    - _需求: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 9.1, 9.2, 9.3_

  - [ ]* 2.3 编写属性测试：Output Channel 事件过滤
    - **属性 1: Output Channel 事件过滤**
    - 提取纯函数 `isKiroLogsDocument(scheme: string, identifier: string): boolean`
    - 使用 fast-check 生成任意 scheme 和 identifier 字符串，验证仅当 scheme === "output" 且 identifier 包含 "Kiro Logs" 时返回 true
    - **验证需求: 1.1, 1.5**

  - [ ]* 2.4 编写属性测试：WriteFile 日志解析与路径提取
    - **属性 2: WriteFile 日志解析与路径提取**
    - 提取纯函数 `parseWriteFilePath(logText: string): string | null`
    - 使用 fast-check 生成包含 `[WriteFile]` 和有效文件路径的日志文本，验证提取的路径与输入路径一致
    - **验证需求: 1.2**

  - [ ]* 2.5 编写属性测试：Agent 状态机转换
    - **属性 3: Agent 状态机转换**
    - 提取纯函数 `updateAgentState(state: {active: boolean, sessionId: string}, logText: string): {active: boolean, sessionId: string}`
    - 验证 `[AgentIterator]` 使状态变为活跃且首次生成新 session ID，连续多个 `[AgentIterator]` 不重复生成 session ID，`activeExecution":false` 使状态变为非活跃
    - **验证需求: 1.3, 1.4**

  - [ ]* 2.6 编写属性测试：AI 编辑标记与时间窗口
    - **属性 4: AI 编辑标记与时间窗口**
    - 提取纯函数 `isWithinEditWindow(markTimestamp: number, queryTimestamp: number, windowMs: number): boolean`
    - 使用 fast-check 生成任意时间戳对和窗口值，验证差值 < windowMs 返回 true，差值 >= windowMs 返回 false
    - **验证需求: 2.1, 2.2, 2.3**

  - [x] 2.7 实现 Stable Content Cache 管理
    - `handleDocumentOpen`: 对 `scheme === "file"` 的文档，将内容缓存到 `stableFileContent`
    - `handleDocumentChange`（file scheme）: 文件内容变更后设置 2 秒 debounce 定时器，静默期后更新 `stableFileContent`
    - `handleDocumentClose`: 清除 `stableFileContent` 缓存和 `stableContentTimers` 定时器
    - _需求: 4.1, 4.2, 4.5_

  - [x] 2.8 实现 Human Checkpoint 触发逻辑
    - 当 `[WriteFile]` 事件标记文件为 AI 编辑时，使用 `stableFileContent` 中的缓存内容触发 human checkpoint
    - 构造 `type: "human"` payload，包含 `repo_working_dir`、`will_edit_filepaths`、`dirty_files`（使用缓存的稳定内容）
    - 对同一文件进行 500ms debounce 处理
    - 通过 `callCheckpointAgentV1` 执行 checkpoint
    - _需求: 4.3, 4.4, 5.1, 5.2_

  - [ ]* 2.9 编写属性测试：Human Checkpoint Payload 构造
    - **属性 6: Human Checkpoint Payload 构造**
    - 提取纯函数 `buildHumanPayload(workingDir: string, filePaths: string[], dirtyFiles: Record<string, string>): object`
    - 验证返回的 payload 包含 `type: "human"`、`repo_working_dir` 等于 workingDir、`will_edit_filepaths` 等于 filePaths、`dirty_files` 等于 dirtyFiles
    - **验证需求: 5.2**

  - [x] 2.10 实现文件保存事件处理与 AI Checkpoint 触发
    - `handleDocumentSave`: 对保存事件进行 300ms debounce 处理
    - `evaluateSaveForCheckpoint`: debounce 结束后检查文件是否在 AI_Edit_Window 内被标记为 AI 编辑
    - 如果是 AI 编辑：从 VS Code TextDocument 内存获取文件内容，构造 `type: "ai_agent"` payload，通过 `callCheckpointAgentV1` 执行 checkpoint，成功后清除 AI 编辑标记
    - 如果不是 AI 编辑：跳过 checkpoint
    - `resolveWorkingDir`: 确定文件所在的 git 仓库根目录或 workspace 目录
    - _需求: 3.1, 3.2, 3.3, 3.4, 3.5, 2.4, 5.1, 5.3_

  - [ ]* 2.11 编写属性测试：Checkpoint 触发决策
    - **属性 5: Checkpoint 触发决策**
    - 提取纯函数 `shouldTriggerCheckpoint(filePath: string, aiEditedFiles: Map<string, number>, now: number): boolean`
    - 验证文件在窗口内被标记时返回 true，未标记或过期时返回 false
    - **验证需求: 3.2, 3.3**

  - [ ]* 2.12 编写属性测试：AI Checkpoint Payload 构造
    - **属性 7: AI Checkpoint Payload 构造**
    - 提取纯函数 `buildAiPayload(workingDir: string, filePath: string, sessionId: string, dirtyFiles: Record<string, string>): object`
    - 验证返回的 payload 包含 `type: "ai_agent"`、`agent_name: "kiro"`、`model: "kiro-ai"`、`conversation_id` 等于 sessionId 等所有必需字段
    - **验证需求: 5.3**

  - [ ]* 2.13 编写属性测试：忽略模式过滤
    - **属性 9: 忽略模式过滤**
    - 复用 `checkpoint.ts` 中的 `matchesIgnorePattern` 函数
    - 验证匹配忽略模式的文件路径不会被标记为 AI 编辑
    - **验证需求: 9.1, 9.2**

- [x] 3. 检查点 - 确保核心模块编译通过
  - 确保所有代码编译通过，检查 TypeScript 类型错误，如有问题请询问用户。

- [x] 4. 实现状态栏集成
  - [x] 4.1 在 AIEditManager 中集成 StatusBar 状态更新
    - `start()` 成功后设置 "watching" 状态
    - checkpoint 执行前设置 "checkpointing" 状态
    - checkpoint 成功后设置 "success" 状态（StatusBar 自动 2 秒后恢复 "watching"）
    - checkpoint 失败后设置 "failure" 状态（StatusBar 自动 2 秒后恢复 "watching"）
    - binary 不可用时设置 "inactive" 状态
    - _需求: 7.1, 7.2, 7.3, 7.4, 5.4, 5.5_

- [x] 5. 修改 extension.ts 入口，替换 KiroLogWatcher 为 AIEditManager
  - [x] 5.1 重写 extension.ts 的 activate 函数
    - 移除 `import { KiroLogWatcher } from "./logWatcher"` 导入
    - 新增 `import { AIEditManager } from "./ai-edit-manager"` 导入
    - 创建 `AIEditManager` 实例，调用 `setStatusBar` 和 `start`，设置状态栏为 "watching"
    - 将 AIEditManager 注册到 `context.subscriptions`
    - 移除 KiroLogWatcher 相关的创建、重试逻辑
    - 保留 `initBundledBinary`、`isBinaryReady` 检查、git shim 配置、CommitWatcher 初始化
    - _需求: 6.1, 6.2, 6.3, 6.5_

- [x] 6. 清理旧模块代码
  - [x] 6.1 删除 `logWatcher.ts` 文件
    - _需求: 8.1_
  - [x] 6.2 删除 `logParser.ts` 文件
    - _需求: 8.2_
  - [x] 6.3 清理 `config.ts` 中仅被 KiroLogWatcher 使用的函数
    - 移除 `getKiroGlobalStoragePath`、`findExecutionLogDirs`、`decodeWorkspaceDirName`、`encodeWorkspacePath` 函数
    - 如果 config.ts 中没有其他导出函数，则删除整个文件
    - _需求: 8.3_

- [x] 7. 最终检查点 - 确保所有代码编译通过
  - 确保所有代码编译通过，无 TypeScript 类型错误，所有导入引用正确，如有问题请询问用户。

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加速 MVP 开发
- 每个任务引用了具体的需求编号以确保可追溯性
- 属性测试验证设计文档中定义的正确性属性
- 参考实现位于 `agent-support/kiro/temp/ai-edit-manager.ts`，可作为实现参考但需适配 kiro 插件的模块结构（使用 `checkpoint.ts` 中的 bundled binary 而非全局 `git-ai` 命令）
