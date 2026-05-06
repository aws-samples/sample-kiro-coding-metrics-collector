# 需求文档

## 简介

Kiro VS Code 扩展通过 `AIEditManager` 追踪 AI 代码编写归属。当前实现仅通过匹配 "Kiro Logs" 输出通道中的 `[WriteFile]` 模式来检测 AI 文件写入。然而，在 spec 驱动开发流程中，AI 通过 `fsWrite`、`strReplace`、`taskStatus` 等工具写入文件，这些操作不会产生 `[WriteFile]` 日志条目。这导致所有 spec 生成的代码在 git 提交时被错误归属为"人类编写"而非"AI 编写"。

本需求文档定义了扩展检测机制的增强方案，使其能够识别来自所有 Kiro agent 活动的 AI 文件写入，包括 spec 任务执行、taskStatus 更新以及其他基于工具的文件修改。

## 术语表

- **AIEditManager**: Kiro 扩展中负责追踪 AI 编辑文件并触发检查点的核心类
- **Kiro_Logs**: VS Code 输出通道，名称为 "Kiro Logs"，记录 Kiro agent 的活动日志
- **Checkpoint**: 通过 git-ai 二进制文件创建的归属快照，记录文件的 AI/人类编辑状态
- **Spec_Task_Execution**: Kiro 的 spec 驱动开发流程，AI 通过工具调用执行任务并写入文件
- **WriteFile_Pattern**: 当前用于检测 AI 文件写入的日志模式 `[WriteFile]`
- **Tool_Signal**: Kiro Logs 中表示工具调用的日志模式，如 `fsWrite`、`strReplace`、`taskStatus` 等
- **Agent_Session**: 从 `[AgentIterator]` 开始到 `activeExecution":false` 结束的一次 AI agent 活动周期
- **Cooldown_Window**: AI 编辑标记的有效期（当前为 15 秒），超时后标记过期
- **Ignore_Pattern**: 配置中定义的文件路径排除模式，匹配的文件不参与 AI 归属追踪

## 需求

### 需求 1：检测 spec 任务执行中的工具写入

**用户故事：** 作为使用 spec 驱动开发的开发者，我希望 AI 通过 fsWrite 和 strReplace 工具写入的文件能被正确标记为 AI 编辑，以便 git 提交时归属准确。

#### 验收标准

1. WHEN Kiro_Logs 中出现包含 `fsWrite` 工具调用及文件路径的日志条目, THE AIEditManager SHALL 将该文件路径标记为 AI 编辑
2. WHEN Kiro_Logs 中出现包含 `strReplace` 工具调用及文件路径的日志条目, THE AIEditManager SHALL 将该文件路径标记为 AI 编辑
3. WHEN Kiro_Logs 中出现包含 `taskStatus` 工具调用的日志条目, THE AIEditManager SHALL 将关联的 tasks.md 文件路径标记为 AI 编辑
4. WHEN 工具调用日志中的文件路径匹配 Ignore_Pattern, THE AIEditManager SHALL 跳过该文件的 AI 编辑标记并记录忽略日志

### 需求 2：保持现有 WriteFile 检测兼容性

**用户故事：** 作为使用常规 Kiro agent 的开发者，我希望现有的 `[WriteFile]` 检测机制继续正常工作，以便非 spec 流程的 AI 归属不受影响。

#### 验收标准

1. THE AIEditManager SHALL 继续检测 Kiro_Logs 中的 `[WriteFile]` 模式并标记对应文件为 AI 编辑
2. WHEN Kiro_Logs 中同时出现 `[WriteFile]` 和工具调用日志指向同一文件, THE AIEditManager SHALL 使用最新的时间戳更新该文件的 AI 编辑标记
3. WHEN 仅存在 `[WriteFile]` 日志而无工具调用日志, THE AIEditManager SHALL 仅通过 `[WriteFile]` 模式完成 AI 编辑检测

### 需求 3：Agent 会话期间的工具信号识别

**用户故事：** 作为开发者，我希望只有在 AI agent 活跃会话期间的工具调用才被视为 AI 编辑，以避免误将人类操作标记为 AI 编辑。

#### 验收标准

1. WHILE Agent_Session 处于活跃状态, THE AIEditManager SHALL 解析工具调用日志并标记对应文件为 AI 编辑
2. WHILE Agent_Session 未处于活跃状态, THE AIEditManager SHALL 忽略工具调用日志中的文件写入信号
3. WHEN Kiro_Logs 中出现 `[AgentIterator]` 标记, THE AIEditManager SHALL 开始一个新的 Agent_Session 并对所有打开的文件创建预编辑快照
4. WHEN Kiro_Logs 中出现 `activeExecution":false` 标记, THE AIEditManager SHALL 结束当前 Agent_Session

### 需求 4：工具调用日志的文件路径提取

**用户故事：** 作为开发者，我希望扩展能从各种工具调用日志格式中准确提取文件路径，以便所有 AI 写入的文件都能被追踪。

#### 验收标准

1. WHEN 工具调用日志包含 `"path"` 字段, THE AIEditManager SHALL 从该字段提取文件的绝对路径或相对路径
2. WHEN 工具调用日志包含 `"targetFile"` 字段, THE AIEditManager SHALL 从该字段提取文件路径
3. WHEN 工具调用日志包含 `"taskFilePath"` 字段, THE AIEditManager SHALL 从该字段提取 tasks.md 文件路径
4. IF 工具调用日志中无法提取有效文件路径, THEN THE AIEditManager SHALL 记录警告日志并跳过该条目
5. WHEN 提取到相对路径, THE AIEditManager SHALL 将其解析为基于工作区根目录的绝对路径

### 需求 5：检查点触发的正确性

**用户故事：** 作为开发者，我希望通过工具调用检测到的 AI 编辑文件在保存时能正确触发检查点，以便 git 提交前归属数据已就绪。

#### 验收标准

1. WHEN 被标记为 AI 编辑的文件被保存, THE AIEditManager SHALL 先执行人类检查点再执行 AI 检查点（顺序执行）
2. WHEN 通过工具调用标记的文件在 Cooldown_Window 内被保存, THE AIEditManager SHALL 触发检查点流程
3. WHEN 通过工具调用标记的文件在 Cooldown_Window 过期后被保存, THE AIEditManager SHALL 视该文件为非 AI 编辑并跳过检查点
4. THE AIEditManager SHALL 对通过 `[WriteFile]` 和工具调用两种方式标记的文件使用相同的检查点流程

### 需求 6：日志解析的鲁棒性

**用户故事：** 作为开发者，我希望日志解析能够处理各种格式变化和异常情况，以便检测机制在不同场景下都能稳定工作。

#### 验收标准

1. IF Kiro_Logs 中的工具调用日志格式不符合预期, THEN THE AIEditManager SHALL 记录解析错误并继续处理后续日志条目
2. WHEN 单条日志变更包含多个工具调用, THE AIEditManager SHALL 逐一解析并标记所有涉及的文件
3. THE AIEditManager SHALL 在解析工具调用日志时使用与 `[WriteFile]` 检测相同的 Ignore_Pattern 过滤逻辑
