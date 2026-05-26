# Kiro Logs Output Channel 调查报告

## 背景

git-ai for Kiro 插件通过监听 Kiro IDE 的 Output Channel（名为 "Kiro Logs"）来检测 AI 编辑事件。具体机制是注册 `vscode.workspace.onDidChangeTextDocument` 事件，过滤 `scheme === "output"` 且 `fsPath` 包含 `"Kiro Logs"` 的文档变更，从中解析 `[WriteFile]`、`[AgentIterator]`、工具调用日志等关键信息。

插件在 macOS 上测试正常，但在 Windows 上完全无法检测到 AI 编辑，导致所有代码归因为 human。

## 调查过程

### 第一轮：加诊断日志

在 `handleDocumentChange` 中添加日志，记录所有 `scheme !== "file"` 的文档变更事件。

**Windows 结果**：
- 只观察到 `vscode-scm` scheme 的事件（git commit 输入框）
- **零个** `output` scheme 的事件
- 没有任何 `Document opened` 带 output scheme 的日志

**macOS 结果**：
- 出现了 `Kiro agent session started` 和 `Kiro AI wrote file` 日志（来自 Output Channel 监听路径）
- 但同样**没有** `[DEBUG]` 前缀的诊断日志（因为 macOS 上跑的是旧版本代码）

### 第二轮：确认 macOS 行为

在 macOS 上部署带诊断日志的版本重新测试。

**关键发现**：macOS 日志中也**没有**任何 `[DEBUG] Non-file doc change: scheme=output` 事件。`Kiro AI wrote file` 日志确实出现了，但这说明 Output Channel 监听在 macOS 上是生效的 — 只是诊断日志没有被触发，因为 macOS 上跑的版本不包含诊断代码。

### 第三轮：定位根因

搜索 VS Code 官方 issue tracker，找到关键 issue：

> **[microsoft/vscode#171334](https://github.com/microsoft/vscode/issues/171334)**：Output channel text model is only updated when output channel is visible
>
> `onDidChangeTextDocument` 对 Output Channel 的事件**只在该 Output Channel 面板可见时才触发**。如果 Output Channel 面板没有打开，或者切换到了其他 Output Channel，事件就不会触发。

这是 VS Code 的已知行为，不是 bug，不是平台差异。

## 根因

**`onDidChangeTextDocument` 对 Output Channel 的事件只在该 Output Channel 可见时才触发。**

- macOS 上测试时，Kiro Logs Output Channel 面板恰好是打开/可见的，所以事件能触发
- Windows 上测试时，Kiro Logs Output Channel 面板没有打开，所以事件不触发
- 这不是 macOS vs Windows 的平台差异，而是 Output Channel 是否可见的差异
- 在任何平台上，只要 Kiro Logs 面板没有打开，Output Channel 监听就不工作

## 影响范围

Output Channel 监听是当前插件 AI 编辑检测的**唯一机制**。它失效意味着：

1. `[AgentIterator]` 检测不到 → agent session 状态机不工作
2. `[WriteFile]` 检测不到 → 文件不会被标记为 AI 编辑
3. 工具调用日志检测不到 → fsWrite/strReplace 等操作不会被标记
4. 没有 AI 编辑标记 → `evaluateSaveForCheckpoint` 跳过所有文件
5. 没有 checkpoint → post-commit 生成的 authorship note 中没有 AI 归因
6. 所有代码行被标记为 human → 上报的统计数据中 `ai_additions = 0`

## 结论

> **⚠️ 此方案已被 Session Log 实时监听方案完全替代。**
>
> Output Channel 监听方案因依赖面板可见性而不可靠（见上述根因分析），已在 [kiro-session-monitor](../../.kiro/specs/kiro-session-monitor/) 功能中被**彻底移除**。`AIEditManager` 类及其所有相关代码（`onDidChangeTextDocument` 监听、`extractJsonFieldValue`、`parseToolCallPaths` 等）已从代码库中完全删除。
>
> 新方案通过 `fs.watch` 实时监听 Kiro IDE 持久化到磁盘的 Execution Log 目录变化，当检测到新的或更新的执行日志时，立即解析 AI 代码编辑记录并写入 git-ai working logs。该方案完全不依赖任何 UI 状态或 Output Channel 可见性。
>
> **替代方案实现代码：**
> - [`src/sessionLogWatcher.ts`](../src/sessionLogWatcher.ts) — 实时监听 Execution Log 目录变化（核心组件，替代 `AIEditManager`）
> - [`src/sessionLogParser.ts`](../src/sessionLogParser.ts) — 执行日志解析（纯函数，支持 Format A/B 双格式）
> - [`src/sessionLogScanner.ts`](../src/sessionLogScanner.ts) — 日志文件发现、读取与过滤（协调器）
> - [`src/workspacePathEncoder.ts`](../src/workspacePathEncoder.ts) — 工作区路径 URL-safe Base64 编解码
> - [`src/checkpointPayload.ts`](../src/checkpointPayload.ts) — Checkpoint Payload 构建
>
> **参考文档：**
> - [kiro-session-log-investigation-v2.md](./kiro-session-log-investigation-v2.md) — Session Log 方案的详细调查与设计依据
