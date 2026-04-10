# Kiro AI Coverage Collector

自动追踪 Kiro AI 生成代码和人工代码的行级归属，在 commit 时上报指标。

## 安装即用

安装本插件（VSIX），打开项目即自动生效。无需额外依赖。

插件激活后自动完成：
- 通过 Kiro Logs 检测 AI 编辑，自动记录 checkpoint
- 监听文件保存事件，记录人工编辑
- 在 git commit 时计算 AI/人工/混合编辑指标并上报

完全静默运行，无 hooks，无用户可见输出。

## 工作原理

```
Kiro AI 写入文件
  → 插件检测 Kiro Logs 中的 [WriteFile] 事件
  → 标记文件为 AI 编辑
  → 文件保存时触发 ai_agent checkpoint

用户手动编辑文件
  → 无 Kiro Logs 事件
  → 文件保存时触发 human checkpoint

git commit
  → 插件检测 HEAD 变化
  → 读取 checkpoint 数据，计算 AI/人工/混合行数
  → 上报到配置的 HTTP 接口
```

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `kiroAiCoverage.enableCheckpointLogging` | `false` | 启用 checkpoint 日志通知 |
| `kiroAiCoverage.statsUploadUrl` | `""` | commit stats 上报 URL |
| `kiroAiCoverage.statsUploadToken` | `""` | 上报接口的 Bearer token |
