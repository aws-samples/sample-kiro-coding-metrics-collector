# git-ai for Kiro

通过 [Kiro hooks](https://kiro.dev/docs/hooks/) 集成 [git-ai](https://github.com/git-ai-project/git-ai)，自动追踪 AI 生成代码和人工代码的行级归属。

## 安装即用

1. 安装 [git-ai CLI](https://github.com/git-ai-project/git-ai#quick-start)
2. 在项目中初始化：`git-ai install-hooks`
3. 安装本插件（VSIX），打开项目即自动生效

插件激活后会自动完成：
- 将 Kiro hook 文件写入工作区 `.kiro/hooks/` 目录
- 监听 AI 写入工具调用，自动触发 checkpoint
- 监听文件保存事件，记录人工编辑
- 新 prompt 提交时刷新会话基线

无需任何手动配置。

## 工作流程

```
用户提交 prompt
  → [promptSubmit hook] human checkpoint（刷新基线）

Kiro AI 准备写文件
  → [preToolUse(write) hook] human checkpoint（标记之前的人工变更）

Kiro AI 写入文件
  → [postToolUse(write) hook] ai_agent checkpoint（标记 AI 变更）

用户手动保存文件
  → [插件内部监听] human checkpoint

git commit
  → git-ai post-commit hook 生成 AuthorshipLog
```

## 查看结果

```bash
git-ai blame src/main.ts    # 查看 AI 归属
git-ai stats                 # 查看提交统计
```

## 命令

- `Git AI: 手动触发 Checkpoint` - 手动创建 checkpoint
- `Git AI: 移除工作区 Hooks` - 清理插件自动安装的 hook 文件

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `gitAiKiro.enableCheckpointLogging` | `false` | 启用 checkpoint 日志通知 |
| `gitAiKiro.agentName` | `kiro` | 上报给 git-ai 的 agent 名称 |
| `gitAiKiro.model` | `kiro-ai` | 上报给 git-ai 的模型名称 |
