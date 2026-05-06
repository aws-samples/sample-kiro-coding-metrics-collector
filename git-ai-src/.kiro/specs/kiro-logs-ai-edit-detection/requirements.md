# 需求文档

## 简介

优化 `agent-support/kiro` VS Code 插件的 AI 编辑检测机制。将现有的基于 `fs.watch()` 监听 Kiro globalStorage 执行日志 JSON 文件的方案，替换为基于 Kiro Logs Output Channel 日志事件监听的方案。新方案通过 `vscode.workspace.onDidChangeTextDocument` 监听 Output Channel 的 `[WriteFile]` 日志来识别 AI 编辑的文件，结合 `onDidSaveTextDocument` 事件触发 git-ai checkpoint，实现更精确、更可靠的 AI 编辑归因。

## 术语表

- **Extension**: git-ai-kiro VS Code 插件，运行在 Kiro IDE 中，负责 AI 编辑检测和 checkpoint 触发
- **Kiro_Logs_Channel**: Kiro IDE 的 "Kiro Logs" Output Channel，Kiro agent 在执行操作时会向该通道写入结构化日志
- **AI_Edit_Manager**: 新的 AI 编辑管理器模块，替代现有的 KiroLogWatcher 和 logParser，负责监听 Output Channel 日志、标记 AI 编辑文件、触发 checkpoint
- **Checkpoint**: git-ai 的 checkpoint 命令，用于记录文件的 AI/人工编辑归因信息
- **Agent_Session**: Kiro agent 的一次活跃会话，从 agent 开始执行到结束的完整生命周期
- **WriteFile_Event**: Kiro agent 写文件时在 Kiro_Logs_Channel 中产生的 `[WriteFile] completed...{filePath}` 日志事件
- **AgentIterator_Event**: Kiro agent 活跃时在 Kiro_Logs_Channel 中产生的 `[AgentIterator]` 日志事件
- **AI_Edit_Window**: 文件被标记为 AI 编辑后的有效时间窗口，在此窗口内保存文件将触发 AI checkpoint
- **Human_Checkpoint**: 在 AI 编辑发生前记录文件原始内容的 checkpoint，用于建立编辑前基线
- **AI_Checkpoint**: 在 AI 编辑完成后记录文件修改内容的 checkpoint，用于归因 AI 编辑
- **Stable_Content_Cache**: 缓存文件在编辑前的稳定内容，用于 human checkpoint 的 dirty_files 数据
- **Bundled_Binary**: 插件内置的 git-ai 二进制文件，用于执行 checkpoint 命令

## 需求

### 需求 1：Output Channel 日志监听

**用户故事：** 作为插件开发者，我希望通过监听 Kiro Logs Output Channel 的文档变更来检测 AI 编辑事件，以便替代现有的文件系统监听方案，获得更可靠的检测能力。

#### 验收标准

1. WHEN Kiro_Logs_Channel 的文档内容发生变更，THE AI_Edit_Manager SHALL 通过 `vscode.workspace.onDidChangeTextDocument` 事件接收变更内容（通过检查 `document.uri.scheme === "output"` 且文档标识包含 "Kiro Logs"）
2. WHEN 变更内容中包含 `[WriteFile]` 关键字和文件路径，THE AI_Edit_Manager SHALL 提取文件路径并将该文件标记为 AI 编辑，记录当前时间戳
3. WHEN 变更内容中包含 `[AgentIterator]` 关键字，THE AI_Edit_Manager SHALL 将 Kiro agent 状态标记为活跃，并在首次检测到时生成新的 session ID
4. WHEN 变更内容中包含 agent 结束标识（如 `activeExecution":false`），THE AI_Edit_Manager SHALL 将 Kiro agent 状态标记为非活跃
5. WHEN 文档变更事件的 `document.uri.scheme` 不是 "output" 或文档标识不包含 "Kiro Logs"，THE AI_Edit_Manager SHALL 忽略该事件（不进行日志解析处理）

### 需求 2：AI 编辑文件标记与时间窗口管理

**用户故事：** 作为插件开发者，我希望对 AI 编辑的文件进行带时间戳的标记和过期管理，以便在文件保存时准确判断该次保存是否由 AI 编辑触发。

#### 验收标准

1. WHEN 一个文件被 WriteFile_Event 标记为 AI 编辑，THE AI_Edit_Manager SHALL 在内部映射中记录该文件路径和标记时间戳
2. WHEN 查询一个文件是否为 AI 编辑时，THE AI_Edit_Manager SHALL 检查标记时间戳是否在 AI_Edit_Window（15 秒）内，超过窗口期的标记视为过期并清除
3. WHEN 同一文件在窗口期内被多次标记为 AI 编辑，THE AI_Edit_Manager SHALL 更新该文件的时间戳为最新值
4. THE AI_Edit_Manager SHALL 在 AI checkpoint 触发成功后清除对应文件的 AI 编辑标记，避免重复触发

### 需求 3：文件保存事件处理与 Checkpoint 触发

**用户故事：** 作为插件开发者，我希望在文件保存时根据 AI 编辑标记决定是否触发 checkpoint，以便实现精确的 AI 编辑归因。

#### 验收标准

1. WHEN 一个文件被保存（`onDidSaveTextDocument`），THE AI_Edit_Manager SHALL 对保存事件进行 debounce 处理（300ms 窗口），避免短时间内重复触发
2. WHEN debounce 窗口结束后评估保存事件时，如果该文件在 AI_Edit_Window 内被标记为 AI 编辑，THE AI_Edit_Manager SHALL 触发 AI_Checkpoint，传入 agent-v1 preset、session ID、编辑文件路径、workspace 目录和 dirty_files 数据
3. WHEN debounce 窗口结束后评估保存事件时，如果该文件未被标记为 AI 编辑，THE AI_Edit_Manager SHALL 跳过 checkpoint 触发（视为人工编辑）
4. WHEN 触发 AI_Checkpoint 时，THE AI_Edit_Manager SHALL 从 VS Code 内存中的 TextDocument 获取文件内容（而非从文件系统读取），以处理远程开发场景下的文件系统延迟
5. WHEN 触发 AI_Checkpoint 时，THE AI_Edit_Manager SHALL 确定文件所在的 git 仓库根目录或 workspace 目录作为 checkpoint 的工作目录

### 需求 4：Human Checkpoint 与文件内容快照

**用户故事：** 作为插件开发者，我希望在 AI 编辑发生前捕获文件的原始内容快照，以便 git-ai 能够准确计算 AI 编辑的 diff。

#### 验收标准

1. WHEN 一个文件首次在编辑器中打开（`onDidOpenTextDocument`，scheme 为 "file"），THE AI_Edit_Manager SHALL 将文件当前内容缓存到 Stable_Content_Cache 中
2. WHEN 文件内容发生变更（`onDidChangeTextDocument`，scheme 为 "file"），THE AI_Edit_Manager SHALL 在一段静默期（2 秒）后更新 Stable_Content_Cache 中的内容
3. WHEN 检测到 WriteFile_Event 标记某文件为 AI 编辑，THE AI_Edit_Manager SHALL 触发 Human_Checkpoint，使用 Stable_Content_Cache 中的内容作为编辑前基线
4. WHEN 触发 Human_Checkpoint 时，THE AI_Edit_Manager SHALL 对同一文件进行 debounce 处理（500ms 窗口），避免短时间内重复触发
5. WHEN 文件在编辑器中关闭（`onDidCloseTextDocument`），THE AI_Edit_Manager SHALL 清除该文件在 Stable_Content_Cache 中的缓存及相关定时器

### 需求 5：Checkpoint 命令执行

**用户故事：** 作为插件开发者，我希望通过调用 bundled git-ai binary 执行 checkpoint 命令，以便将 AI 编辑归因数据写入 git 仓库。

#### 验收标准

1. WHEN 执行 checkpoint 命令时，THE AI_Edit_Manager SHALL 使用 `agent-v1` preset 调用 Bundled_Binary（`git-ai checkpoint agent-v1 --hook-input stdin`）
2. WHEN 执行 Human_Checkpoint 时，THE AI_Edit_Manager SHALL 构造 `type: "human"` 的 JSON payload，包含 `repo_working_dir`、`will_edit_filepaths` 和 `dirty_files` 字段
3. WHEN 执行 AI_Checkpoint 时，THE AI_Edit_Manager SHALL 构造 `type: "ai_agent"` 的 JSON payload，包含 `repo_working_dir`、`agent_name: "kiro"`、`model: "kiro-ai"`、`conversation_id`（session ID）、`edited_filepaths`、`dirty_files` 和 `transcript` 字段
4. IF Bundled_Binary 不存在或未就绪，THEN THE AI_Edit_Manager SHALL 记录错误日志并跳过 checkpoint 执行
5. IF checkpoint 命令执行失败（非零退出码），THEN THE AI_Edit_Manager SHALL 记录错误日志并更新状态栏为失败状态

### 需求 6：插件生命周期管理

**用户故事：** 作为插件开发者，我希望 AI_Edit_Manager 正确集成到插件的激活和停用流程中，以便替代现有的 KiroLogWatcher。

#### 验收标准

1. WHEN Extension 激活时，THE Extension SHALL 创建 AI_Edit_Manager 实例并注册所有必要的 VS Code 事件监听器（`onDidChangeTextDocument`、`onDidSaveTextDocument`、`onDidOpenTextDocument`、`onDidCloseTextDocument`）
2. WHEN Extension 激活时，THE Extension SHALL 不再创建 KiroLogWatcher 实例，也不再依赖 `config.ts` 中的 globalStorage 路径查找和 `logParser.ts` 中的执行日志解析
3. WHEN Extension 激活时，THE Extension SHALL 继续初始化 Bundled_Binary、配置 git shim 路径、创建 CommitWatcher 和 StatusBar
4. WHEN Extension 停用时，THE AI_Edit_Manager SHALL 清除所有定时器、缓存和事件监听器，释放资源
5. THE Extension SHALL 将 AI_Edit_Manager 注册到 `context.subscriptions` 中，确保插件停用时自动调用 dispose

### 需求 7：状态栏集成

**用户故事：** 作为用户，我希望在状态栏中看到 AI 编辑检测的当前状态，以便了解插件是否正常工作。

#### 验收标准

1. WHEN AI_Edit_Manager 成功初始化并开始监听，THE StatusBar SHALL 显示 "watching" 状态
2. WHEN AI_Edit_Manager 正在执行 checkpoint，THE StatusBar SHALL 显示 "checkpointing" 状态
3. WHEN checkpoint 执行成功，THE StatusBar SHALL 短暂显示 "success" 状态后恢复为 "watching"
4. IF checkpoint 执行失败，THEN THE StatusBar SHALL 短暂显示 "failure" 状态后恢复为 "watching"

### 需求 8：模块清理与代码移除

**用户故事：** 作为插件开发者，我希望移除不再需要的旧模块代码，以便保持代码库的整洁。

#### 验收标准

1. THE Extension SHALL 移除 `logWatcher.ts` 文件（KiroLogWatcher 类及其 fs.watch 逻辑）
2. THE Extension SHALL 移除 `logParser.ts` 文件（parseExecutionLog 及相关接口和函数）
3. THE Extension SHALL 移除 `config.ts` 中仅被 KiroLogWatcher 使用的函数（`getKiroGlobalStoragePath`、`findExecutionLogDirs`、`decodeWorkspaceDirName`、`encodeWorkspacePath`）
4. THE Extension SHALL 保留 `checkpoint.ts` 中的 `initBundledBinary`、`getGitAiBinary`、`getGitShimPath`、`isBinaryReady`、`getIgnorePatterns`、`matchesIgnorePattern` 函数
5. THE Extension SHALL 保留 `commitWatcher.ts`、`statsUploader.ts`、`statusBar.ts` 模块不变

### 需求 9：Ignore Pattern 支持

**用户故事：** 作为用户，我希望 AI 编辑检测能够尊重已配置的忽略模式，以便排除不需要追踪的文件。

#### 验收标准

1. WHEN 一个文件被 WriteFile_Event 标记为 AI 编辑时，THE AI_Edit_Manager SHALL 检查该文件路径是否匹配 `gitai.kiro.ignorePatterns` 配置中的任何模式
2. IF 文件路径匹配忽略模式，THEN THE AI_Edit_Manager SHALL 跳过该文件的 AI 编辑标记和 checkpoint 触发
3. THE AI_Edit_Manager SHALL 复用 `checkpoint.ts` 中现有的 `getIgnorePatterns` 和 `matchesIgnorePattern` 函数
