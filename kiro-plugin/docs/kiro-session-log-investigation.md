# Kiro Session 日志调查报告

## 调查目标

评估从 Kiro IDE 的 session 日志中提取 AI 代码修改记录的可行性，用于计算 AI 代码入库率（AI 产出代码占 git 提交代码的比例）。

## 日志存储位置

### macOS 路径

```
~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/
```

该目录下有以下关键子目录：

| 目录 | 说明 |
|------|------|
| `sessions/` | 全局 session 索引，包含 `sessions.json` 和各 session 的 JSON 文件 |
| `workspace-sessions/` | 按工作区组织的 session，目录名为工作区路径的 Base64 编码 |
| `<hash>/414d.../` | 执行日志（Execution Logs），每次 AI 执行对应一个 JSON 文件 |

### workspace-sessions 目录结构

```
workspace-sessions/
├── L1VzZXJzL2ZxY2hlbi9jb2RlL2F3cy9haS1jb2RlLWNvbW1pdC10cmFja2Vy/   # Base64 编码的工作区路径
│   ├── sessions.json                    # session 索引
│   ├── 8cbb2dea-...-b591e6a00d0e.json   # 单个 session 的对话历史
│   ├── 4a3e7d3e-...-675d0db66feb.json
│   └── ...
└── L1VzZXJzL2ZxY2hlbi9jb2RlL2F3cy9sYWIvcGV0Y2hhdA__/
    └── ...
```

目录名解码示例：
```
L1VzZXJzL2ZxY2hlbi9jb2RlL2F3cy9haS1jb2RlLWNvbW1pdC10cmFja2Vy
→ Base64 解码 →
/Users/fqchen/code/aws/ai-code-commit-tracker
```

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

### Session JSON 文件

Session 文件记录的是对话历史（user/assistant 消息），**不包含**工具调用的详细参数和结果。
Assistant 的回复中通过 `executionLog` 引用执行日志：

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "executionLog",
      "text": "f4af2915-f59f-4bea-aa9f-392d10d7d0f2"  // executionId
    }
  ]
}
```

## 执行日志（Execution Logs）— 核心数据源

### 存储位置

```
~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/<workspace-hash>/414d.../
```

每个文件是一次完整的 AI 执行记录，文件名为 hash，大小从几十 KB 到 1MB+ 不等。

### 顶层结构

```json
{
  "executionId": "5521fca1-9347-4aa3-8fdc-5b7653baf934",
  "workflowType": "chat-agent",
  "status": "succeed",
  "startTime": 1774110620041,
  "endTime": 1774110680000,
  "autonomyMode": "...",
  "chatSessionId": "...",
  "actions": [...],          // ← 关键：所有工具调用记录
  "graph": {...},
  "context": {"messages": [...]},
  "result": {...},
  "usageSummary": {...}
}
```

### actions 数组 — 工具调用的完整记录

每个 action 代表一次工具调用或系统操作：

```json
{
  "type": "AgentExecutionAction",
  "executionId": "...",
  "actionId": "...",
  "actionState": "Accepted",    // Accepted | Error | Success
  "actionType": "replace",      // 操作类型
  "input": {...},               // 工具输入参数
  "output": {...},              // 工具输出结果（部分 action 有）
  "chatSessionId": "...",
  "emittedAt": 1774110625000
}
```

## 所有已发现的 actionType

通过遍历所有执行日志，发现以下 actionType：

| actionType | 说明 | 与代码修改相关 |
|------------|------|:---:|
| `replace` | 修改已有文件 | ✅ |
| `create` | 新建文件 | ✅ |
| `write` | 写入文件（fsWrite） | ✅ |
| `append` | 追加文件内容 | ✅ |
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

## 代码修改操作的详细数据结构

### replace（修改已有文件）

这是最常见的代码修改操作，包含修改前后的**完整文件内容**：

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
- `file`: 相对于工作区的文件路径
- `originalContent`: 修改前的完整文件内容
- `modifiedContent`: 修改后的完整文件内容
- `actionState`: `Accepted` 表示用户接受了修改，`Error` 表示操作失败

实际观察到的数据示例：

| 文件 | 修改前行数 | 修改后行数 | actionState |
|------|-----------|-----------|-------------|
| src/index.ts | 201 | 273 | Accepted |
| src/index.ts | 273 | 275 | Accepted |
| src/hook-manager.ts | 263 | 262 | Accepted |
| tests/unit/hook-manager.test.ts | 307 | 308 | Accepted |
| tests/unit/cli.test.ts | 226 | 227 | Accepted |

### create（新建文件）

```json
{
  "actionType": "create",
  "actionState": "Accepted",
  "input": {
    "file": "src/pet_chat/agent/agent_api_service.py",
    "modified": "kiro-diff:/src/pet_chat/agent/agent_api_service.py?commitId%3D...",
    "local": "file:///Users/fqchen/code/aws/lab/petchat/src/pet_chat/agent/agent_api_service.py",
    "originalContent": "",
    "modifiedContent": "\"\"\"Agent API 服务\n\n提供 HTTP RESTful API 接口...\"\"\"\n\nfrom typing import Optional\n..."
  }
}
```

关键区别：`originalContent` 为空字符串，`modifiedContent` 为完整的新文件内容。

## actionState 状态说明

| 状态 | 含义 | 是否应计入 AI 产出 |
|------|------|:---:|
| `Accepted` | 用户接受了 AI 的修改 | ✅ |
| `Error` | 操作执行失败 | ❌ |
| `Success` | 操作成功（通常用于非代码修改操作） | 视情况 |

## 可行性评估

### ✅ 可行的部分

1. **数据完整性高**：每次代码修改都记录了完整的修改前后内容，可以精确计算行级 diff
2. **状态可过滤**：`actionState=Accepted` 可以过滤掉失败和被拒绝的操作
3. **文件路径明确**：`file` 字段是相对于工作区的路径，可以直接与 git diff 的路径匹配
4. **时间戳可用**：`emittedAt` 和执行日志的 `startTime`/`endTime` 可以用于时间范围匹配
5. **工作区可定位**：通过 Base64 解码目录名可以定位到具体的工作区

### ⚠️ 风险和限制

1. **内部格式无保证**：这些日志是 Kiro 的内部实现，没有公开 API，版本升级后格式可能变化
2. **日志可能被清理**：Kiro 可能有缓存清理机制，旧的执行日志可能被删除
3. **跨平台路径差异**：macOS 上路径为 `~/Library/Application Support/Kiro/`，Linux 和 Windows 路径不同
4. **大文件性能**：单个执行日志可能超过 1MB，需要考虑解析性能
5. **多次修改同一文件**：一次执行中可能多次修改同一文件（如 action[11] 和 action[14] 都修改 src/index.ts），需要正确处理链式修改

### 与 git diff 匹配的思路

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
1. 解析执行日志，提取所有 `actionState=Accepted` 的写操作
2. 对 `originalContent` 和 `modifiedContent` 做 diff，得到 AI 修改的具体行
3. 解析 `git log --patch` 的 diff，得到实际提交的变更行
4. 将两者按文件路径和行内容做匹配，计算重合度

## 与其他方案的对比

| 维度 | Hook 方案 | Session 日志方案 | git commit 标记方案 |
|------|----------|----------------|-------------------|
| 数据精度 | 低（难以稳定获取 diff） | 高（完整的修改前后内容） | 中（commit 级别，非行级） |
| 实现复杂度 | 中 | 中 | 低 |
| 稳定性 | 低（Hook 可能丢事件） | 高（数据已持久化） | 高（git 原生支持） |
| 格式稳定性 | 中（Hook API 相对稳定） | 低（内部格式可能变化） | 高（git 标准格式） |
| 实时性 | 高（事件驱动） | 低（需要定期扫描） | 低（需要 commit 后分析） |
| 跨工具支持 | 仅 Kiro | 仅 Kiro | 需要各工具适配 |

## 结论

从 Kiro session 日志中提取 AI 代码修改记录是**可行的**，且数据质量优于 Hook 方案。建议作为 Kiro 专用的数据采集模块来实现，同时保留 git commit 分析作为通用的兜底方案。
