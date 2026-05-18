---
name: Bug Report
about: 报告插件或 Dashboard 的问题
title: '[Bug] '
labels: bug
assignees: ''
---

## 环境信息

- **操作系统**: [ ] Windows 10/11  [ ] macOS  [ ] Linux
- **插件版本**: （如 0.2.2，在 Kiro 扩展面板查看）
- **Kiro IDE 版本**: （Help → About 查看）
- **Git 版本**: （终端执行 `git --version`）
- **Workspace 结构**: [ ] 单 git 项目  [ ] 多 git 项目  [ ] .code-workspace 多根

## 问题描述

简要描述遇到的问题。

## 复现步骤

1. 打开 Kiro IDE，加载项目 `xxx`
2. 使用 AI 编辑文件 `xxx`
3. 执行 `git commit -m "xxx"`
4. 观察到 ...

## 预期行为

描述你期望的正确行为。

## 实际行为

描述实际发生的错误行为（如 ai_additions=0、上报失败、hook 未执行等）。

## 插件日志

> 获取方式：Kiro IDE → Help → Toggle Developer Tools → Console 面板 → 筛选 `[git-ai-kiro]`

```
粘贴相关日志（至少包含从 "Processing X write action(s)" 到 "checkpoint succeeded/failed" 的完整流程）
```

## 上报记录（如适用）

> 文件位置：`<项目>/.git/ai/last_upload_payload.json` 最后几行

```json
粘贴最近的 [stats] 记录
```

## post-commit hook 日志（如适用）

> 文件位置：`<项目>/.git/ai/post_commit_debug.log`（如果有）
> 或手动执行 hook 查看输出：`sh .git/hooks/post-commit`

```
粘贴相关日志
```

## 补充信息

- 是否使用了 git commit --amend？
- 是否一次 AI 操作修改了多个文件后分多次 commit？
- Workspace 中 git 项目的目录层级结构是怎样的？
- 是否有网络代理或防火墙限制？
