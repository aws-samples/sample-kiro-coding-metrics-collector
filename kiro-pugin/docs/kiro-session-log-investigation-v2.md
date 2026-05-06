# Kiro Session 日志调查报告 v2

## 调查目标

评估从 Kiro IDE 的 session 日志中提取 AI 代码修改记录的可行性，用于计算 AI 代码入库率（AI 产出代码占 git 提交代码的比例）。

## 日志存储位置

### 跨平台路径

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/` |
| Windows | `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\` |
| Linux | `~/.config/Kiro/User/globalStorage/kiro.kiroagent/`（推测，未验证） |

Windows 展开后为 `C:\Users\<username>\AppData\Roaming\Kiro\User\globalStorage\kiro.kiroagent\`。

### 目录结构

```
kiro.kiroagent/
├── .diffs/
├── .migrations/
├── .utils/
├── sessions/                             # 全局 session 索引
│   └── sessions.json
├── workspace-sessions/                   # 按工作区组织的 session
│   ├── <base64-encoded-workspace-path>/
│   │   ├── sessions.json                 # 该工作区的 session 索引
│   │   ├── <sessionId>.json              # 单个 session 的对话历史
│   │   └── ...
│   └── ...
├── <workspace-hash>/                     # 执行日志（Execution Logs）
│   └── 414d.../                          # 子目录（含义待确认）
│       ├── <execution-hash>              # 单次 AI 执行记录（JSON）
│       └── ...
├── default/
├── dev_data/
└── index/
```

### workspace-sessions 目录

目录名为工作区绝对路径的 **URL-safe Base64** 编码。

解码示例：

| 编码目录名 | 解码结果 | 平台 |
|-----------|---------|------|
| `L1VzZXJzL2ZxY2hlbi9jb2RlL2F3cy9haS1jb2RlLWNvbW1pdC10cmFja2Vy` | `/Users/fqchen/code/aws/ai-code-commit-tracker` | macOS |
| `ZDpcY29kZVxkdW1teS1wcm9qZWN0` | `d:\code\dummy-project` | Windows |

注意事项：
- URL-safe Base64 使用 `-` 替代 `+`，`_` 替代 `/` 和 `=`
- Windows 上编码的是反斜杠路径，macOS 上是正斜杠路径

### sessions.json 格式

```json
[
  {
    "sessionId": "8cbb2dea-7d17-4d5c-9022-b591e6a00d0e",
    "title": "阅读 .kiro/specs/ai-code-commit-tracker/design.md...",
    "dateCreated": "1774110620041",
    "workspaceDirectory": "/Users/fqchen/code/aws/ai-code-commit-tracker"
  }
]
```

Windows 上 `workspaceDirectory` 使用反斜杠：`"d:\\code\\dummy-project"`。

### Session JSON 文件

Session 文件记录对话历史（user/assistant 消息），**不包含**工具调用的详细参数和结果。
Assistant 的回复中通过 `executionLog` 引用执行日志：

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "executionLog",
      "text": "f4af2915-f59f-4bea-aa9f-392d10d7d0f2"
    }
  ]
}
```

## 执行日志（Execution Logs）— 核心数据源

### 存储位置

```
<kiro-agent-dir>/<workspace-hash>/414d.../
```

每个文件是一次完整的 AI 执行记录，文件名为 hash，大小从几十 KB 到 1MB+ 不等。

### workspace-hash 与工作区的映射

hash 目录名（如 `bf3e60d417c42501632cb85e407b2a17`）本身不直接编码工作区路径。
映射方式：执行日志中的 `chatSessionId` 字段关联到 `workspace-sessions/<base64>/sessions.json` 中的 `sessionId`，从而确定所属工作区。

### 顶层结构

执行日志存在**两种格式**，取决于 Kiro 的工作流类型：

#### 格式 A：带 actions 数组（Autopilot / Spec 工作流）

```json
{
  "executionId": "5521fca1-9347-4aa3-8fdc-5b7653baf934",
  "workflowType": "chat-agent",
  "status": "succeed",
  "startTime": 1774110620041,
  "endTime": 1774110680000,
  "autonomyMode": "...",
  "chatSessionId": "...",
  "actions": [...],
  "graph": {...},
  "context": {"messages": [...]},
  "result": {...},
  "usageSummary": {...}
}
```

`actions` 数组包含所有工具调用的完整记录，**包括 `originalContent` 和 `modifiedContent`**。
这是提取 AI 代码修改的首选数据源。

#### 格式 B：仅 context.messages（Chat 工作流）

```json
{
  "executionId": "ee36290f-d76f-45f8-8b29-3818e012011b",
  "workflowType": "chat-agent",
  "status": "succeed",
  "startTime": 1776422830137,
  "endTime": 1776422842631,
  "chatSessionId": "...",
  "context": {
    "messages": [
      {"role": "human", "entries": [...]},
      {"role": "bot", "entries": [...]},
      {"role": "tool", "entries": [...]},
      ...
    ]
  },
  "result": {...},
  "usageSummary": [...]
}
```

工具调用信息嵌套在 `context.messages` 中：
- `role: "bot"` 的 `entries` 包含 `type: "toolUse"` 条目（工具名 + 参数）
- `role: "tool"` 的 `entries` 包含 `type: "toolUseResponse"` 条目（执行结果）

此格式**不包含** `originalContent` / `modifiedContent`，但包含工具调用参数（如 `fsWrite` 的 `path` 和 `text`），可以用于识别 AI 编辑了哪些文件以及写入的内容。

### 两种格式的数据提取策略

优先使用格式 A 的 `actions` 数组（数据最完整），格式 B 作为 fallback：

```javascript
function extractWriteOperations(executionLog) {
  // 策略 1：从 actions 数组提取（格式 A，数据最完整）
  if (executionLog.actions?.length > 0) {
    return executionLog.actions
      .filter(a => ["replace", "create", "write", "append", "editCode", "delete"]
                      .includes(a.actionType))
      .filter(a => a.actionState === "Accepted")
      .map(a => ({
        type: a.actionType,
        file: a.input?.file,
        originalContent: a.input?.originalContent,
        modifiedContent: a.input?.modifiedContent,
        emittedAt: a.emittedAt,
      }));
  }

  // 策略 2：从 context.messages 提取（格式 B，仅工具参数）
  const writes = [];
  for (const msg of executionLog.context?.messages || []) {
    if (msg.role === "bot") {
      for (const entry of msg.entries || []) {
        if (entry.type === "toolUse" &&
            ["fsWrite", "strReplace", "fsAppend", "deleteFile"].includes(entry.name)) {
          writes.push({
            type: entry.name,
            file: entry.args?.path || entry.args?.targetFile,
            content: entry.args?.text,
            args: entry.args,
          });
        }
      }
    }
  }
  return writes;
}
```

## actions 数组详细结构（格式 A）

### action 通用结构

```json
{
  "type": "AgentExecutionAction",
  "executionId": "...",
  "actionId": "...",
  "actionState": "Accepted",
  "actionType": "replace",
  "input": {...},
  "output": {...},
  "chatSessionId": "...",
  "emittedAt": 1774110625000
}
```

### 所有已发现的 actionType

| actionType | 说明 | 与代码修改相关 |
|------------|------|:---:|
| `replace` | 修改已有文件（strReplace） | ✅ |
| `create` | 新建文件 | ✅ |
| `write` | 写入文件（fsWrite） | ✅ |
| `append` | 追加文件内容（fsAppend） | ✅ |
| `editCode` | AST 级别代码编辑 | ✅ |
| `delete` | 删除文件 | ✅ |
| `smartRelocate` | 移动/重命名文件 | ✅ |
| `readCode` | 读取代码文件 | ❌ |
| `readFiles` | 读取文件 | ❌ |
| `search` | 搜索文件 | ❌ |
| `runCommand` | 执行 shell 命令 | ❌ |
| `getDiagnostics` | 获取代码诊断信息 | ❌ |
| `remote_web_search` | 网络搜索 | ❌ |
| `webFetch` | 获取网页内容 | ❌ |
| `say` | AI 回复文本 | ❌ |
| `model` | 模型调用 | ❌ |
| `intentClassification` | 意图分类 | ❌ |
| `steering` | 加载 steering 规则 | ❌ |
| `invokeSubAgent` | 调用子 agent | ❌ |
| `subagentResponse` | 子 agent 响应 | ❌ |
| `controlProcess` | 控制后台进程 | ❌ |
| `getProcessOutput` | 获取进程输出 | ❌ |
| `listProcesses` | 列出进程 | ❌ |
| `ContextualHookInvoked` | Hook 触发 | ❌ |
| `specAgent` | Spec agent 操作 | ❌ |
| `taskStatus` | 任务状态变更 | ❌ |
| `pbtStatus` | PBT 状态 | ❌ |
| `summarization` | 上下文摘要 | ❌ |
| `preWork` | 预处理 | ❌ |
| `userInput` | 用户输入 | ❌ |
| `userMessage` | 用户消息 | ❌ |
| `displayError` | 显示错误 | ❌ |

### actionState 状态说明

| 状态 | 含义 | 是否应计入 AI 产出 |
|------|------|:---:|
| `Accepted` | 用户接受了 AI 的修改 | ✅ |
| `Error` | 操作执行失败 | ❌ |
| `Success` | 操作成功（通常用于非代码修改操作） | 视情况 |

## 代码修改操作的详细数据结构

### replace（修改已有文件）

最常见的代码修改操作，包含修改前后的**完整文件内容**：

```json
{
  "actionType": "replace",
  "actionState": "Accepted",
  "input": {
    "file": "src/index.ts",
    "original": "kiro-diff:/src/index.ts?commitId%3Dd63109d5%26executionId%3D...",
    "modified": "kiro-diff:/src/index.ts?commitId%3D1dc8834b%26executionId%3D...",
    "local": "file:///Users/fqchen/code/aws/ai-code-commit-tracker/src/index.ts",
    "originalContent": "import { existsSync } from 'node:fs';\n...(完整的修改前文件内容)",
    "modifiedContent": "import { existsSync } from 'node:fs';\n...(完整的修改后文件内容)"
  }
}
```

关键字段：
- `file`：相对于工作区的文件路径
- `originalContent`：修改前的完整文件内容
- `modifiedContent`：修改后的完整文件内容
- `local`：文件的 file URI（Windows 上 `:` 编码为 `%3A`，如 `file:///d%3A/code/...`）

### create（新建文件）

```json
{
  "actionType": "create",
  "actionState": "Accepted",
  "input": {
    "file": "src/pet_chat/agent/agent_api_service.py",
    "local": "file:///Users/fqchen/code/aws/lab/petchat/src/pet_chat/agent/agent_api_service.py",
    "originalContent": "",
    "modifiedContent": "\"\"\"Agent API 服务...\"\"\"\n\nfrom typing import Optional\n..."
  }
}
```

`originalContent` 为空字符串 `""`（不是 `null` 或 `undefined`）。

### append（追加文件内容）

```json
{
  "actionType": "append",
  "actionState": "Accepted",
  "input": {
    "file": "test1.js",
    "local": "file:///d%3A/code/dummy-project/test1.js",
    "originalContent": "function greet(name) {\n  return ...(追加前的完整文件内容)",
    "modifiedContent": "function greet(name) {\n  return ...(追加后的完整文件内容)"
  }
}
```

`originalContent` 为追加前的完整文件内容，`modifiedContent` 为追加后的完整文件内容。

### 实际观察到的数据示例

| 文件 | actionType | 修改前行数 | 修改后行数 | actionState |
|------|-----------|-----------|-----------|-------------|
| test1.js | create | 0 | 11 | Accepted |
| test1.js | append | 11 | 16 | Accepted |
| src/index.ts | replace | 201 | 273 | Accepted |
| src/index.ts | replace | 273 | 275 | Accepted |
| src/hook-manager.ts | replace | 263 | 262 | Accepted |

## context.messages 中的工具调用结构（格式 B）

当执行日志没有 `actions` 数组时，工具调用信息在 `context.messages` 中：

### bot 消息中的 toolUse

```json
{
  "role": "bot",
  "entries": [
    {
      "id": "tooluse_eTAQHd7olxBNcYCN2VEDIo",
      "type": "toolUse",
      "name": "fsWrite",
      "args": {
        "path": "test1.js",
        "text": "function greet(name) {\n  return `Hello, ${name}!`;\n}\n..."
      },
      "requestMessageId": "59a8e0bf-b1c0-40d8-bb42-56be94289e71"
    }
  ]
}
```

### tool 消息中的 toolUseResponse

```json
{
  "role": "tool",
  "entries": [
    {
      "id": "tooluse_eTAQHd7olxBNcYCN2VEDIo",
      "type": "toolUseResponse",
      "name": "fsWrite",
      "args": {
        "path": "test1.js",
        "text": "function greet(name) {\n  return `Hello, ${name}!`;\n}\n..."
      },
      "success": true,
      "message": "Created the test1.js file."
    }
  ]
}
```

`id` 字段关联 toolUse 和 toolUseResponse。`success: true` 表示操作成功。

## 可行性评估

### ✅ 可行的部分

1. **数据完整性高**：格式 A 的 `actions` 数组记录了完整的修改前后内容，可以精确计算行级 diff
2. **格式 B 可作为 fallback**：即使没有 `actions` 数组，`context.messages` 中的工具调用参数也能识别 AI 编辑的文件和写入内容
3. **状态可过滤**：`actionState=Accepted`（格式 A）或 `success: true`（格式 B）可以过滤掉失败的操作
4. **文件路径明确**：`file` 字段是相对于工作区的路径，可以直接与 git diff 的路径匹配
5. **时间戳可用**：`emittedAt`（格式 A）和执行日志的 `startTime`/`endTime` 可以用于时间范围匹配
6. **工作区可定位**：通过 `chatSessionId` → `sessions.json` 的 `sessionId` 可以定位到具体的工作区
7. **跨平台验证通过**：macOS 和 Windows 上的数据结构一致，仅路径格式不同

### ⚠️ 风险和限制

1. **内部格式无保证**：这些日志是 Kiro 的内部实现，没有公开 API，版本升级后格式可能变化
2. **日志可能被清理**：Kiro 可能有缓存清理机制，旧的执行日志可能被删除
3. **大文件性能**：单个执行日志可能超过 1MB，需要考虑解析性能
4. **多次修改同一文件**：一次执行中可能多次修改同一文件，需要正确处理链式修改
5. **两种格式并存**：需要同时处理格式 A（actions 数组）和格式 B（context.messages），增加实现复杂度
6. **格式 B 数据不完整**：`context.messages` 中的工具调用不包含 `originalContent`，只有写入的内容，无法直接计算 diff

## 与 git diff 匹配的思路

```
AI 执行日志                              Git 提交
┌─────────────┐                    ┌─────────────┐
│ replace      │                    │ git diff     │
│ file: a.ts   │   diff 匹配        │ a.ts         │
│ original → modified │ ──────────→ │ +10 lines    │
│ +72 lines AI 产出   │             │ -3 lines     │
└─────────────┘                    └─────────────┘

AI 代码入库率 = AI 产出且被 git 提交的行数 / git 提交的总变更行数
```

具体步骤：
1. 解析执行日志，提取所有 `actionState=Accepted` 的写操作（优先 `actions` 数组，fallback 到 `context.messages`）
2. 对 `originalContent` 和 `modifiedContent` 做 diff，得到 AI 修改的具体行（格式 A）；或从工具参数中提取写入内容（格式 B）
3. 解析 `git log --patch` 的 diff，得到实际提交的变更行
4. 将两者按文件路径和行内容做匹配，计算重合度

## 与其他方案的对比

| 维度 | Output Channel 监听 | Session 日志方案 | FileSystemWatcher |
|------|---------------------|----------------|-------------------|
| 数据精度 | 低（只有文件路径） | 高（完整的修改前后内容） | 低（只知道文件变了） |
| 跨平台可靠性 | ❌ 依赖 Output Channel 可见性 | ✅ 数据已持久化到磁盘 | ⚠️ 需要过滤噪音 |
| 实现复杂度 | 低 | 中 | 中 |
| 格式稳定性 | 中（Output Channel 格式可能变） | 低（内部格式可能变） | 高（OS 级 API） |
| 实时性 | 高（事件驱动） | 中（需要扫描或 watch 日志文件） | 高（事件驱动） |
| 数据完整性 | 低（丢事件风险高） | 高（Kiro 自己写入，不会丢） | 低（无法区分 AI/人类） |

## 结论

> **✅ 此推荐方案已实现。**
> 以下推荐的实现策略已在 [kiro-session-monitor spec](../../.kiro/specs/kiro-session-monitor/) 功能中完成。
> 实际代码文件：
> - [`src/sessionLogWatcher.ts`](../src/sessionLogWatcher.ts) — 实时监听 Execution Log 目录变化，触发解析和 checkpoint 流程
> - [`src/sessionLogParser.ts`](../src/sessionLogParser.ts) — 执行日志解析，支持 Format A 和 Format B
> - [`src/sessionLogScanner.ts`](../src/sessionLogScanner.ts) — 日志扫描协调器，编排文件系统操作和过滤逻辑
> - [`src/workspacePathEncoder.ts`](../src/workspacePathEncoder.ts) — 工作区路径 URL-safe Base64 编解码
> - [`src/checkpointPayload.ts`](../src/checkpointPayload.ts) — 从 WriteAction 构建 AICheckpointPayload

从 Kiro session 日志中提取 AI 代码修改记录是**可行的**，且数据质量和跨平台可靠性均优于 Output Channel 监听方案。Output Channel 监听已完全移除，不再作为补充检测手段。

推荐实现策略：
1. **主方案**：读取执行日志的 `actions` 数组，提取带 `originalContent`/`modifiedContent` 的写操作
2. **Fallback**：当 `actions` 数组不存在时，从 `context.messages` 中提取工具调用参数
3. **触发时机**：通过 `fs.watch` 实时监听 Execution Log 目录变化，当检测到新的或更新的执行日志时，立即解析 AI 编辑数据并调用 `callCheckpointAgentV1` 写入 git-ai working logs
