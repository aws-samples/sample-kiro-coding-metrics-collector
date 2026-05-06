# 实现计划：kiro-spec-ai-edit-detection

## 概述

扩展 `AIEditManager` 的 AI 编辑检测机制，使其能识别 Kiro Logs 中基于工具调用（`fsWrite`、`strReplace`、`taskStatus` 等）的文件写入信号。实现采用增量方式：先添加纯函数和常量导出，再集成到 `AIEditManager` 类中，最后通过属性测试和单元测试验证正确性。

## Tasks

- [x] 1. 添加常量定义和纯函数 `extractJsonFieldValue`
  - [x] 1.1 在 `agent-support/kiro/src/ai-edit-manager.ts` 顶部导出 `FILE_WRITE_TOOLS` 和 `TASK_STATUS_TOOL` 常量
    - `FILE_WRITE_TOOLS = ["fsWrite", "strReplace", "deleteFile", "fsAppend"] as const`
    - `TASK_STATUS_TOOL = "taskStatus" as const`
    - 同时定义内部 `TOOL_PATH_FIELDS` 映射（工具名称 → JSON 字段名）
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 1.2 实现并导出纯函数 `extractJsonFieldValue(text: string, fieldName: string): string | null`
    - 使用正则从日志文本中提取指定 JSON 字段的字符串值
    - 支持 `"path"`、`"targetFile"`、`"taskFilePath"` 字段
    - 无法提取时返回 `null`，不抛出异常
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 1.3 编写 `extractJsonFieldValue` 的属性测试
    - **Property 7: JSON 字段值提取**
    - **Validates: Requirements 4.1, 4.2, 4.3**
    - 在 `agent-support/kiro/src/__tests__/aiEditDetection.property.test.ts` 中创建测试
    - 对于任意字段名和字符串值，构造包含该字段的 JSON 文本，验证提取结果与原始值一致
    - 对于不包含指定字段的文本验证返回 `null`

- [x] 2. 实现纯函数 `parseToolCallPaths` 并编写属性测试
  - [x] 2.1 实现并导出纯函数 `parseToolCallPaths(text: string, agentActive: boolean): string[]`
    - 当 `agentActive` 为 `false` 时直接返回空数组
    - 匹配日志文本中的工具名称（`FILE_WRITE_TOOLS` 和 `TASK_STATUS_TOOL`）
    - 使用 `extractJsonFieldValue` 从对应的 JSON 字段中提取文件路径
    - 支持单条日志中包含多个工具调用
    - 对于格式错误或无法解析的输入返回空数组，不抛出异常
    - _Requirements: 1.1, 1.2, 1.3, 3.1, 3.2, 4.1, 4.2, 4.3, 4.4, 6.1, 6.2_

  - [x] 2.2 编写 `parseToolCallPaths` 的属性测试 — 工具调用文件路径提取
    - **Property 1: 工具调用文件路径提取**
    - **Validates: Requirements 1.1, 1.2, 1.3, 4.1, 4.2, 4.3**
    - 在 `agent-support/kiro/src/__tests__/aiEditDetection.property.test.ts` 中添加
    - 对于任意已知工具名称和有效文件路径，构造日志文本，验证提取路径与原始路径一致

  - [x] 2.3 编写 `parseToolCallPaths` 的属性测试 — Agent Session 状态门控
    - **Property 2: Agent Session 状态门控**
    - **Validates: Requirements 3.1, 3.2**
    - `agentActive=true` 时返回提取到的路径；`agentActive=false` 时返回空数组

  - [x] 2.4 编写 `parseToolCallPaths` 的属性测试 — 解析鲁棒性
    - **Property 4: 解析鲁棒性**
    - **Validates: Requirements 4.4, 6.1**
    - 对于任意字符串输入（空字符串、随机文本、格式错误的 JSON），函数不抛出异常且返回空数组

  - [x] 2.5 编写 `parseToolCallPaths` 的属性测试 — 单条日志多工具调用提取
    - **Property 5: 单条日志多工具调用提取**
    - **Validates: Requirements 6.2**
    - 构造包含多个工具调用的日志文本，验证返回路径数量等于有效工具调用数量

- [x] 3. 检查点 — 确保所有测试通过
  - 运行 `npm test` 确保所有测试通过，如有问题请向用户确认。

- [x] 4. 在 `AIEditManager` 中集成工具调用解析
  - [x] 4.1 添加私有方法 `resolveToAbsolutePath(filePath: string): string | null`
    - 如果路径已是绝对路径，直接返回
    - 如果是相对路径，使用工作区根目录拼接为绝对路径
    - 无法解析时返回 `null` 并记录警告日志
    - _Requirements: 4.5_

  - [x] 4.2 添加私有方法 `extractToolCallPaths(text: string): string[]`
    - 调用纯函数 `parseToolCallPaths(text, this.kiroAgentActive)` 获取路径列表
    - 对每个路径调用 `resolveToAbsolutePath` 转换为绝对路径
    - 过滤掉无法解析的路径
    - _Requirements: 1.1, 1.2, 1.3, 3.1, 3.2, 4.5_

  - [x] 4.3 修改 `handleKiroLogsChange` 方法，在现有 `[WriteFile]` 检测之后添加工具调用解析
    - 在每个 `change` 的处理循环中，调用 `extractToolCallPaths(text)` 获取文件路径
    - 对每个路径执行 ignore pattern 过滤（复用 `getIgnorePatterns` 和 `matchesIgnorePattern`）
    - 通过过滤的路径调用 `this.kiroAiEditedFiles.set(filePath, Date.now())` 标记 AI 编辑
    - 记录相应的 console.log 日志
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 3.1, 5.2, 5.4, 6.3_

  - [x] 4.4 编写 `resolveToAbsolutePath` 的属性测试
    - **Property 6: 相对路径解析**
    - **Validates: Requirements 4.5**
    - 在 `agent-support/kiro/src/__tests__/aiEditDetection.property.test.ts` 中添加
    - 对于任意工作区根目录和相对路径，验证返回正确拼接结果；绝对路径原样返回

  - [x] 4.5 编写集成行为的单元测试
    - 在 `agent-support/kiro/src/__tests__/aiEditDetection.unit.test.ts` 中创建
    - 测试 `[WriteFile]` 模式继续正常工作（需求 2.1、2.3）
    - 测试 `[WriteFile]` 和工具调用同时标记同一文件时时间戳更新（需求 2.2）
    - 测试 Agent Session 状态机：`[AgentIterator]` 开始、`activeExecution":false` 结束（需求 3.3、3.4）
    - 测试 Ignore Pattern 过滤一致性（需求 1.4、6.3）
    - **Property 3: Ignore Pattern 过滤一致性**
    - **Validates: Requirements 1.4, 6.3**

- [x] 5. 最终检查点 — 确保所有测试通过
  - 运行 `npm test` 确保所有测试通过，如有问题请向用户确认。

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加速 MVP 开发
- 每个任务引用了具体的需求编号以确保可追溯性
- 属性测试使用 `fast-check` 库（已在 devDependencies 中配置）
- 检查点任务确保增量验证
- 所有代码修改仅涉及 `agent-support/kiro/` 目录
