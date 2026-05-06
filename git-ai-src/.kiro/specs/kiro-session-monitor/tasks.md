# 实现计划：Kiro Session Monitor

## 概述

将 Kiro 扩展从不可靠的 Output Channel 监听方案（`AIEditManager`）迁移到基于磁盘 Execution Log 的实时监听方案（`SessionLogWatcher`）。按依赖顺序实现：先创建无依赖的纯函数基础模块，再创建依赖模块，最后做集成和清理。

## 任务

- [x] 1. 更新相关文档，反映从 Output Channel 监听到 Session Log 实时监听的架构变更
  - [x] 1.1 更新 `docs/output-channel-investigation.md` 的结论部分
    - 在结论中明确标注此方案已被 Session Log 实时监听方案完全替代
    - 添加指向新实现代码的链接（`sessionLogWatcher.ts`、`sessionLogParser.ts`、`sessionLogScanner.ts`、`workspacePathEncoder.ts`、`checkpointPayload.ts`）
    - 添加指向 `kiro-session-log-investigation-v2.md` 的参考链接
  - [x] 1.2 更新 `docs/kiro-session-log-investigation-v2.md` 的结论和推荐策略部分
    - 更新推荐实现策略：将"Commit 时触发"改为"实时监听 Execution Log 目录变化"
    - 移除"保留 Output Channel 监听作为补充检测手段"的建议（Output Channel 已完全移除）
    - 更新实际代码文件列表，添加 `sessionLogWatcher.ts` 的引用
    - 标注实现状态为"已实现"并指向 spec 目录
  - [x] 1.3 更新 `README.md`（如存在架构说明）
    - 更新扩展的工作原理描述，反映新的 Session Log 实时监听架构
    - 移除任何关于 Output Channel 监听的描述

- [x] 2. 实现 WorkspacePathEncoder 纯函数模块
  - [x] 2.1 创建 `src/workspacePathEncoder.ts`，实现 `encodeWorkspacePath` 和 `decodeWorkspacePath`
    - 使用 `Buffer.from(str).toString("base64url")` 进行 URL-safe Base64 编码
    - 使用 `Buffer.from(encoded, "base64url").toString()` 进行解码
    - 导出 `WriteAction`、`ParseResult`、`ScanResult`、`AICheckpointPayload` 等共享类型定义
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 2.2 编写 WorkspacePathEncoder 属性测试
    - 创建 `src/__tests__/workspacePathEncoder.property.test.ts`
    - **Property 2: 工作区路径编码 round-trip** — 对任意字符串，`decode(encode(s)) === s`
    - **Property 3: URL-safe Base64 字符集** — 编码输出仅包含 `[A-Za-z0-9_-]`
    - **Validates: Requirements 2.1, 2.3, 2.4, 2.5**

- [x] 3. 实现 SessionLogParser 纯函数模块
  - [x] 3.1 创建 `src/sessionLogParser.ts`，实现 Format A 提取逻辑
    - 定义 `WRITE_ACTION_TYPES` 集合：`["replace", "create", "write", "append", "editCode", "delete", "smartRelocate"]`
    - 实现 `extractFormatAWriteActions(actions: unknown[]): WriteAction[]`
    - 仅提取 `actionState === "Accepted"` 且 `actionType` 在集合中的 action
    - 从 `input` 对象提取 `file`、`originalContent`、`modifiedContent`
    - `create` 类型的 `originalContent` 设为空字符串，`delete` 类型的 `modifiedContent` 设为空字符串
    - 结果按 `emittedAt` 升序排序
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 3.2 实现 Format B 提取逻辑和主入口函数
    - 实现 `extractFormatBWriteActions(messages: unknown[]): WriteAction[]`
    - 扫描 `role: "bot"` 消息中的 `toolUse` 条目，工具名在 `["fsWrite", "strReplace", "fsAppend", "deleteFile"]` 中
    - 通过 `id` 字段匹配 `toolUseResponse`，仅保留 `success === true` 的调用
    - 实现 `parseExecutionLog(jsonString: string): ParseResult` 主入口，自动检测格式
    - 实现 `parseSessionsJson(jsonString: string): string[]` 解析 session ID 列表
    - 实现 `serializeWriteActions` / `deserializeWriteActions` 序列化函数
    - 任何解析错误返回空结果，不抛异常
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 11.1, 11.2, 11.3, 11.4_

  - [x] 3.3 编写 SessionLogParser 属性测试
    - 创建 `src/__tests__/sessionLogParser.property.test.ts`
    - **Property 4: Format A 提取仅返回 Accepted 的写操作**
    - **Property 5: Format A 字段提取保留所有相关字段**
    - **Property 6: 格式自动检测**
    - **Property 7: Format B 工具调用提取与字段映射**
    - **Property 8: 失败的工具调用被排除**
    - **Property 9: 解析鲁棒性** — 任意字符串输入不抛异常
    - **Property 13: WriteAction 序列化 round-trip**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1-4.7, 5.1-5.5, 11.3, 11.4**

- [x] 4. 检查点 — 确保所有测试通过
  - 运行 `vitest --run` 确保所有测试通过，如有问题请询问用户。

- [x] 5. 实现 SessionLogScanner 协调器模块
  - [x] 5.1 创建 `src/sessionLogScanner.ts`，实现跨平台路径解析和文件扫描
    - 实现 `resolveAgentDir(platform?, homeDir?, appData?): string` 静态方法
    - macOS: `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/`
    - Windows: `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\`
    - Linux: `~/.config/Kiro/User/globalStorage/kiro.kiroagent/`
    - 定义 `MAX_FILE_SIZE = 5 * 1024 * 1024`（5MB）
    - 实现 `filterBySessionId(logs, sessionIds): ParseResult[]` 纯函数
    - 实现 `filterByTimeWindow(logs, beforeTimestamp, windowMs): ParseResult[]` 纯函数
    - 实现 `SessionLogScanner` 类：`parseExecutionLogFile`、`getWorkspaceSessionIds`、`scanForAIEdits`
    - 使用 `WorkspacePathEncoder` 编码工作区路径定位 `workspace-sessions` 目录
    - 调用 `SessionLogParser` 解析日志内容
    - 应用 `matchesIgnorePattern` 过滤忽略的文件路径
    - Agent Dir 不存在时记录 warning 并返回空结果
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 9.1, 9.2, 9.3_

  - [x] 5.2 编写 SessionLogScanner 属性测试和单元测试
    - 创建 `src/__tests__/sessionLogScanner.property.test.ts`
    - **Property 1: 跨平台 Agent Dir 路径解析**
    - **Property 10: 时间窗口过滤**
    - **Property 11: Session ID 过滤**
    - **Validates: Requirements 1.1, 1.2, 1.3, 6.2, 6.3**
    - 创建 `src/__tests__/sessionLogScanner.unit.test.ts`
    - 测试 Agent Dir 不存在时的降级行为
    - 测试文件过大跳过逻辑
    - 测试文件读取失败时的跳过和继续
    - **Validates: Requirements 1.4, 6.1, 6.4, 6.5**

- [x] 6. 实现 CheckpointPayload 构建模块
  - [x] 6.1 创建 `src/checkpointPayload.ts`，实现 `buildCheckpointPayload`
    - 接受 `workspacePath`、`WriteAction[]`、`chatSessionId?`、`ignorePatterns?` 参数
    - 设置固定字段：`type: "ai_agent"`、`agent_name: "kiro"`、`model: "kiro-ai"`
    - `edited_filepaths` 去重
    - `dirty_files` 使用 `originalContent`（Format A）或从磁盘读取当前内容（Format B fallback）
    - 多次修改同一文件时使用最新时间戳的 `modifiedContent`
    - 应用 ignore patterns 过滤
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [x] 6.2 编写 CheckpointPayload 属性测试
    - 创建 `src/__tests__/checkpointPayload.property.test.ts`
    - **Property 12: Checkpoint Payload 固定字段与结构** — `type`、`agent_name`、`model`、`repo_working_dir` 正确，`edited_filepaths` 无重复
    - **Validates: Requirements 7.2, 7.3, 7.6**

- [x] 7. 检查点 — 确保所有测试通过
  - 运行 `vitest --run` 确保所有测试通过，如有问题请询问用户。

- [x] 8. 实现 SessionLogWatcher 实时监听模块
  - [x] 8.1 创建 `src/sessionLogWatcher.ts`，实现核心监听逻辑
    - 实现 `SessionLogWatcher` 类，实现 `vscode.Disposable` 接口
    - `start()` 方法：解析 Agent Dir、读取 session IDs、对 `<workspace-hash>/414d*/` 目录设置 `fs.watch`
    - `handleFileChange()` 方法：debounce 300ms，检查文件大小变化去重
    - `processExecutionLog()` 方法：解析日志、按 sessionId 过滤、构建 payload、调用 `callCheckpointAgentV1`
    - 先发送 human checkpoint（`originalContent` 作为 pre-edit 基线），再发送 AI checkpoint
    - 更新 StatusBar 状态（checkpointing → success/failure）
    - `dispose()` 方法：清理所有 watchers、timers、pending changes
    - 所有错误静默降级，记录 `[git-ai-kiro]` 前缀日志
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [x] 8.2 编写 SessionLogWatcher 单元测试
    - 创建 `src/__tests__/sessionLogWatcher.unit.test.ts`
    - 测试 debounce 行为（快速连续文件变化被合并）
    - 测试去重机制（同一文件大小未变化时跳过）
    - 测试错误处理（解析失败不中断监听）
    - 测试 dispose 清理逻辑
    - Mock `fs.watch`、`callCheckpointAgentV1`、`vscode` API
    - **Validates: Requirements 8.1-8.7**

- [x] 9. 集成 SessionLogWatcher 到 extension.ts 并移除 AIEditManager
  - [x] 9.1 修改 `src/extension.ts`，替换 AIEditManager 为 SessionLogWatcher
    - 移除 `import { AIEditManager } from "./ai-edit-manager"`
    - 新增 `import { SessionLogWatcher } from "./sessionLogWatcher"`
    - 在 `activate` 中获取 `workspacePath`，创建 `SessionLogWatcher` 实例
    - 调用 `watcher.setStatusBar(statusBar)` 和 `watcher.start()`
    - 将 watcher 加入 `context.subscriptions`
    - 保留 `CommitWatcher`、`StatusBar`、`cleanupGitPathOverride`、`initBundledBinary` 不变
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_

  - [x] 9.2 删除 `src/ai-edit-manager.ts` 文件
    - 确认所有对 `ai-edit-manager` 的引用已移除
    - _Requirements: 10.1, 10.3, 10.4_

  - [x] 9.3 编写 extension 集成单元测试
    - 创建 `src/__tests__/extensionIntegration.unit.test.ts`
    - 验证 `activate` 函数创建 `SessionLogWatcher` 而非 `AIEditManager`
    - 验证不再注册 Output Channel 的 `onDidChangeTextDocument` 监听器
    - 验证 `CommitWatcher` 仍正常启动
    - **Validates: Requirements 10.1-10.6**

- [x] 10. 清理旧测试文件并最终验证
  - [x] 10.1 移除或更新与 AIEditManager 相关的旧测试文件
    - 移除 `src/__tests__/aiEditDetection.property.test.ts`（测试已删除的 `ai-edit-manager.ts`）
    - 移除 `src/__tests__/aiEditDetection.unit.test.ts`（测试已删除的 `ai-edit-manager.ts`）
    - 保留 `cleanupGitPathOverride.property.test.ts`（测试 `extension.ts` 中仍保留的函数）
    - 保留 `commitWatcherOrdering.property.test.ts` 和 `runPostCommit.property.test.ts`
    - _Requirements: 10.1, 10.3, 10.4_

  - [x] 10.2 运行完整编译和测试验证
    - 运行 `tsc -p ./` 确保 TypeScript 编译无错误
    - 运行 `vitest --run` 确保所有测试通过
    - 确认无对已删除模块的残留引用
    - _Requirements: 10.7, 10.8_

- [x] 11. 最终检查点 — 确保所有测试通过
  - 运行完整编译和测试套件，确保所有测试通过，如有问题请询问用户。

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加速 MVP 开发
- 每个任务引用了具体的需求编号，确保可追溯性
- 检查点任务确保增量验证，及早发现问题
- 属性测试验证纯函数模块的通用正确性属性（使用 `fast-check`）
- 单元测试验证具体场景、边界条件和集成行为
- 所有新模块位于 `agent-support/kiro/src/` 目录
- 所有测试文件位于 `agent-support/kiro/src/__tests__/` 目录
