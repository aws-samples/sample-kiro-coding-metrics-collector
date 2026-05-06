# 需求文档：Kiro Session Monitor

## 简介

Kiro Session Monitor 是 git-ai for Kiro 扩展的核心功能模块，用于替代已被证明不可靠的 Output Channel 监听方案。该模块直接读取 Kiro IDE 持久化到磁盘的 Execution Log 文件，解析 AI 代码编辑记录，并在 git commit 时将 AI 编辑数据传入 git-ai checkpoint 流程，从而准确计算 AI 代码入库率。

## 术语表

- **Execution_Log**：Kiro IDE 持久化到磁盘的 JSON 文件，记录一次完整的 AI 执行过程，包含工具调用、代码修改等详细信息
- **Format_A_Log**：带 `actions` 顶层数组的执行日志格式，包含 `originalContent` 和 `modifiedContent` 完整修改前后内容，通常由 Autopilot / Spec 工作流产生
- **Format_B_Log**：仅包含 `context.messages` 的执行日志格式，工具调用信息嵌套在消息数组中，不包含 `originalContent`，通常由 Chat 工作流产生
- **Write_Action**：从 Execution_Log 中提取的 AI 写操作记录，包含文件路径、操作类型和内容信息
- **Session_Log_Parser**：纯函数模块，负责解析单个 Execution_Log JSON 并提取 Write_Action 列表
- **Session_Log_Scanner**：协调器模块，负责发现、读取和过滤 Execution_Log 文件，调用 Session_Log_Parser 进行解析
- **Workspace_Path_Encoder**：工具模块，负责工作区绝对路径与 URL-safe Base64 编码之间的转换
- **Checkpoint_Payload_Builder**：工具模块，负责将 Write_Action 列表转换为 git-ai checkpoint 所需的 AICheckpointPayload 格式
- **Kiro_Agent_Dir**：Kiro IDE 存储 agent 数据的根目录，跨平台路径不同（macOS: `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/`，Windows: `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\`，Linux: `~/.config/Kiro/User/globalStorage/kiro.kiroagent/`）
- **CommitWatcher**：已有模块，通过 VS Code git 扩展 API 监听 HEAD 变化来检测新的本地 commit
- **URL_Safe_Base64**：Base64 编码变体，使用 `-` 替代 `+`，`_` 替代 `/`，省略尾部 `=` 填充符

## 需求

### 需求 1：跨平台 Kiro Agent 目录定位

**用户故事：** 作为扩展开发者，我希望能在 macOS、Windows 和 Linux 上正确定位 Kiro Agent 数据目录，以便读取 Execution_Log 文件。

#### 验收标准

1. WHEN the extension runs on macOS, THE Session_Log_Scanner SHALL resolve Kiro_Agent_Dir to `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/`
2. WHEN the extension runs on Windows, THE Session_Log_Scanner SHALL resolve Kiro_Agent_Dir to `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\`
3. WHEN the extension runs on Linux, THE Session_Log_Scanner SHALL resolve Kiro_Agent_Dir to `~/.config/Kiro/User/globalStorage/kiro.kiroagent/`
4. IF the resolved Kiro_Agent_Dir does not exist on the file system, THEN THE Session_Log_Scanner SHALL log a warning and return an empty result without throwing an error

### 需求 2：工作区路径 URL-safe Base64 编解码

**用户故事：** 作为扩展开发者，我希望能将工作区绝对路径编码为 URL-safe Base64 字符串（以及反向解码），以便定位 `workspace-sessions` 目录下对应工作区的 session 数据。

#### 验收标准

1. THE Workspace_Path_Encoder SHALL encode a workspace absolute path to a URL-safe Base64 string using `-` in place of `+`, `_` in place of `/`, and no trailing `=` padding
2. THE Workspace_Path_Encoder SHALL decode a URL-safe Base64 string back to the original workspace absolute path
3. FOR ALL valid workspace absolute paths, encoding then decoding SHALL produce the original path (round-trip property)
4. WHEN encoding a Windows path containing backslashes (e.g., `d:\code\project`), THE Workspace_Path_Encoder SHALL preserve the backslash characters in the encoded representation
5. WHEN encoding a macOS/Linux path containing forward slashes (e.g., `/Users/dev/project`), THE Workspace_Path_Encoder SHALL preserve the forward slash characters in the encoded representation

### 需求 3：Format A 执行日志解析

**用户故事：** 作为扩展开发者，我希望能从 Format_A_Log 的 `actions` 数组中提取所有被用户接受的 AI 写操作，以便获取完整的修改前后内容用于 AI 归因。

#### 验收标准

1. WHEN a Format_A_Log contains an `actions` array, THE Session_Log_Parser SHALL extract Write_Action records from actions with `actionType` in the set `["replace", "create", "write", "append", "editCode", "delete"]`
2. THE Session_Log_Parser SHALL only include actions where `actionState` equals `"Accepted"`
3. WHEN extracting a `replace` action, THE Session_Log_Parser SHALL capture the `input.file` (relative path), `input.originalContent`, and `input.modifiedContent` fields
4. WHEN extracting a `create` action, THE Session_Log_Parser SHALL capture the `input.file` field and set `originalContent` to an empty string and `modifiedContent` to the `input.modifiedContent` value
5. WHEN extracting an `append` action, THE Session_Log_Parser SHALL capture the `input.file`, `input.originalContent` (pre-append content), and `input.modifiedContent` (post-append content) fields
6. WHEN extracting a `delete` action, THE Session_Log_Parser SHALL capture the `input.file` field and set `modifiedContent` to an empty string
7. THE Session_Log_Parser SHALL preserve the `emittedAt` timestamp from each action in the resulting Write_Action record
8. IF the `actions` array is present but empty, THEN THE Session_Log_Parser SHALL return an empty Write_Action list

### 需求 4：Format B 执行日志解析

**用户故事：** 作为扩展开发者，我希望能从 Format_B_Log 的 `context.messages` 中提取 AI 写操作信息作为 fallback，以便在没有 `actions` 数组时仍能识别 AI 编辑的文件。

#### 验收标准

1. WHEN a Format_B_Log does not contain an `actions` array (or `actions` is null/undefined), THE Session_Log_Parser SHALL fall back to extracting write operations from `context.messages`
2. THE Session_Log_Parser SHALL scan `role: "bot"` messages for `entries` with `type: "toolUse"` and `name` in the set `["fsWrite", "strReplace", "fsAppend", "deleteFile"]`
3. WHEN extracting an `fsWrite` tool call, THE Session_Log_Parser SHALL capture `args.path` as the file path and `args.text` as the written content
4. WHEN extracting a `strReplace` tool call, THE Session_Log_Parser SHALL capture `args.path` as the file path
5. WHEN extracting an `fsAppend` tool call, THE Session_Log_Parser SHALL capture `args.path` as the file path and `args.text` as the appended content
6. WHEN extracting a `deleteFile` tool call, THE Session_Log_Parser SHALL capture `args.targetFile` as the file path
7. THE Session_Log_Parser SHALL verify tool call success by matching `toolUse` entries with corresponding `toolUseResponse` entries (via `id` field) where `success` equals `true`
8. IF `context.messages` is null, undefined, or empty, THEN THE Session_Log_Parser SHALL return an empty Write_Action list

### 需求 5：双格式自动检测与统一输出

**用户故事：** 作为扩展开发者，我希望 Session_Log_Parser 能自动检测执行日志格式并返回统一的 Write_Action 列表，以便调用方无需关心底层格式差异。

#### 验收标准

1. THE Session_Log_Parser SHALL accept a raw JSON object and automatically detect whether it is a Format_A_Log or Format_B_Log
2. WHEN the input JSON contains a non-empty `actions` array, THE Session_Log_Parser SHALL use Format A extraction logic
3. WHEN the input JSON does not contain an `actions` array or the `actions` array is null/undefined, THE Session_Log_Parser SHALL use Format B extraction logic
4. THE Session_Log_Parser SHALL return a unified Write_Action list regardless of the input format, where each Write_Action contains at minimum: `filePath` (string), `actionType` (string), and `timestamp` (number)
5. IF the input JSON is malformed or cannot be parsed, THEN THE Session_Log_Parser SHALL return an empty Write_Action list without throwing an error
6. THE Session_Log_Parser SHALL be implemented as a pure function with no file system or VS Code API dependencies

### 需求 6：执行日志文件发现与扫描

**用户故事：** 作为扩展开发者，我希望能扫描 Kiro_Agent_Dir 下的执行日志文件，并按时间范围过滤，以便只处理与最近 commit 相关的 AI 编辑。

#### 验收标准

1. THE Session_Log_Scanner SHALL enumerate all JSON files under `<Kiro_Agent_Dir>/<workspace-hash>/414d*/` directories
2. WHEN a time range is specified, THE Session_Log_Scanner SHALL only return Execution_Log files whose `startTime` or `endTime` falls within the specified range
3. THE Session_Log_Scanner SHALL use the `chatSessionId` field in each Execution_Log to associate it with a workspace by looking up the matching `sessionId` in `workspace-sessions/<base64>/sessions.json`
4. WHEN scanning for a specific workspace, THE Session_Log_Scanner SHALL only return Execution_Log files associated with that workspace
5. IF an Execution_Log file cannot be read or parsed, THEN THE Session_Log_Scanner SHALL skip the file, log a warning, and continue scanning remaining files
6. THE Session_Log_Scanner SHALL sort returned Execution_Log entries by `startTime` in ascending order

### 需求 7：Checkpoint Payload 构建

**用户故事：** 作为扩展开发者，我希望能将 Write_Action 列表转换为 git-ai checkpoint 所需的 payload 格式，以便通过现有的 `callCheckpointAgentV1` 函数提交 AI 归因数据。

#### 验收标准

1. THE Checkpoint_Payload_Builder SHALL accept a list of Write_Action records and a workspace root path, and produce an AICheckpointPayload object
2. THE Checkpoint_Payload_Builder SHALL set `type` to `"ai_agent"`, `agent_name` to `"kiro"`, and `model` to `"kiro-ai"` in the payload
3. THE Checkpoint_Payload_Builder SHALL populate `edited_filepaths` with the deduplicated list of file paths from all Write_Action records
4. WHEN a Write_Action contains `modifiedContent`, THE Checkpoint_Payload_Builder SHALL include the file path and its `modifiedContent` in the `dirty_files` map
5. WHEN multiple Write_Action records modify the same file, THE Checkpoint_Payload_Builder SHALL use the `modifiedContent` from the Write_Action with the latest timestamp
6. THE Checkpoint_Payload_Builder SHALL set `repo_working_dir` to the provided workspace root path
7. THE Checkpoint_Payload_Builder SHALL filter out file paths that match any of the configured ignore patterns (from `gitai.kiro.ignorePatterns` setting)

### 需求 8：实时 Session Log 监听与 Checkpoint 触发

**用户故事：** 作为扩展开发者，我希望扩展能实时监听 Kiro Execution Log 目录的变化，当检测到新的 AI 编辑被接受时，立即将 AI 编辑数据写入 git-ai working logs，以便在后续 commit 时 authorship note 能正确包含 AI 归因。

#### 验收标准

1. WHEN the extension activates, THE SessionLogWatcher SHALL start monitoring the Kiro Agent Dir execution log directories using `fs.watch`
2. WHEN a new or updated Execution_Log file is detected, THE SessionLogWatcher SHALL parse the file and extract Write_Action records with `actionState === "Accepted"`
3. WHEN Write_Action records are found, THE SessionLogWatcher SHALL use the Checkpoint_Payload_Builder to construct an AICheckpointPayload and call `callCheckpointAgentV1` to write the data into git-ai working logs
4. THE SessionLogWatcher SHALL debounce file change events with a 300ms window to handle Kiro writing to the same file in multiple passes
5. THE SessionLogWatcher SHALL deduplicate processing by tracking file paths and sizes, skipping files whose size has not changed since last processing
6. THE SessionLogWatcher SHALL filter Execution_Log files by `chatSessionId`, only processing logs associated with the current workspace
7. IF the SessionLogWatcher fails to parse or checkpoint a specific file, THEN it SHALL log the error and continue monitoring for subsequent changes without interruption
8. THE CommitWatcher SHALL remain unchanged — it continues to call `runPostCommit` (which reads working logs to generate authorship notes) and `uploadCommitStats` on new commits

### 需求 9：文件路径忽略过滤

**用户故事：** 作为扩展用户，我希望能配置忽略模式来排除特定文件路径（如 `node_modules`、`*.lock`），以便 AI 归因不包含自动生成或第三方文件。

#### 验收标准

1. THE Session_Log_Scanner SHALL apply the `gitai.kiro.ignorePatterns` configuration to filter out Write_Action records whose file paths match any ignore pattern
2. WHEN a Write_Action file path matches an ignore pattern, THE Session_Log_Scanner SHALL exclude that record from the result and log the exclusion
3. THE Session_Log_Scanner SHALL use the same `matchesIgnorePattern` function already defined in `checkpoint.ts` for pattern matching consistency

### 需求 10：移除 Output Channel 监听方案并替换为 Session Log 方案

**用户故事：** 作为扩展开发者，我希望将已被证明不可靠的 Output Channel 监听代码（`AIEditManager`）完全移除，并在 `extension.ts` 中替换为新的 Session Log 监控方案，以便扩展不再依赖 Kiro Logs 面板可见性来检测 AI 编辑。

#### 验收标准

1. THE extension SHALL remove the `AIEditManager` class and its source file `src/ai-edit-manager.ts` entirely
2. THE extension SHALL remove the `import { AIEditManager }` statement and all `AIEditManager` instantiation/usage code from `src/extension.ts`
3. THE extension SHALL remove all Output Channel monitoring logic including `onDidChangeTextDocument` listeners that filter for `scheme === "output"` and `fsPath` containing `"Kiro Logs"`
4. THE extension SHALL remove all helper functions exclusively used by the Output Channel monitoring path, including `extractJsonFieldValue`, `parseToolCallPaths`, and the `handleKiroLogsChange` method
5. THE `extension.ts` `activate` function SHALL integrate the Session_Log_Scanner into the existing `CommitWatcher` flow, replacing the `AIEditManager.start()` call with the new session log based checkpoint mechanism
6. AFTER the migration, THE extension SHALL NOT register any `onDidChangeTextDocument` listeners for Output Channel documents (scheme `"output"`)
7. AFTER the migration, THE extension SHALL produce identical AI checkpoint data for the same set of AI edits as the previous Output Channel approach would have produced when the panel was visible
8. THE extension SHALL retain all existing non-Output-Channel functionality unchanged, including `CommitWatcher`, `StatusBar`, `cleanupGitPathOverride`, and `initBundledBinary`

### 需求 11：Session_Log_Parser 的 Pretty Printer 与 Round-Trip 验证

**用户故事：** 作为扩展开发者，我希望能将 Write_Action 列表序列化为 JSON 并反序列化回来，以便验证解析逻辑的正确性和支持调试输出。

#### 验收标准

1. THE Session_Log_Parser SHALL provide a function to serialize a Write_Action list to a JSON string representation
2. THE Session_Log_Parser SHALL provide a function to deserialize a JSON string back to a Write_Action list
3. FOR ALL valid Write_Action lists, serializing then deserializing SHALL produce an equivalent Write_Action list (round-trip property)
4. THE serialized JSON format SHALL preserve all fields of each Write_Action including `filePath`, `actionType`, `timestamp`, `originalContent` (if present), and `modifiedContent` (if present)

