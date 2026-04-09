# git-ai for Kiro

集成 [git-ai](https://github.com/git-ai-project/git-ai)，自动追踪 Kiro AI 生成代码和人工代码的行级归属，并在 commit 时上报指标。

## 安装即用

1. 安装本插件（VSIX），打开项目即自动生效
2. 根据 IDE 提示安装 git-ai CLI（或自动安装）

插件激活后自动完成：
- 通过 Kiro Logs 检测 AI 编辑，自动触发 ai_agent checkpoint
- 监听文件保存事件，记录人工编辑
- 在 git commit 时自动查询 git-ai stats 并上报到配置的 HTTP 接口
- 在编辑器中显示 AI 代码归属（blame lens）

无需 Kiro hooks，完全静默运行。

## 工作原理

```
Kiro AI 写入文件
  → 插件检测 Kiro Logs 中的 [WriteFile] 事件
  → 标记文件为 AI 编辑
  → 文件保存时触发 ai_agent checkpoint

用户手动编辑文件
  → 无 Kiro Logs 事件
  → 文件保存时不触发 checkpoint（由 git-ai 自动处理）

git commit
  → 插件检测 HEAD 变化
  → 延迟 3 秒等待 authorship note 写入
  → 运行 git-ai stats <sha> --json
  → 上报到配置的 HTTP 接口
```

## 查看结果

```bash
git-ai blame src/main.ts    # 查看 AI 归属
git-ai stats                 # 查看提交统计
```

## 命令

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| `Git AI: Toggle Show AI Code` | `Cmd+Shift+A` | 切换编辑器中 AI 代码高亮显示 |

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `gitai.enableCheckpointLogging` | `false` | 启用 checkpoint 日志通知 |
| `gitai.experiments.aiTabTracking` | `false` | 启用 AI tab 补全追踪（实验性） |
| `gitai.kiro.statsUploadUrl` | `""` | commit stats 上报 URL |
| `gitai.kiro.statsUploadToken` | `""` | 上报接口的 Bearer token |
| `gitai.blameMode` | `line` | AI blame 显示模式：`off` / `line` / `all` |
