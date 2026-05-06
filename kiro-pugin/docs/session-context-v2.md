# Session Context V2 — 2026-04-28~30 修改记录

## 项目概述

git-ai for Kiro 项目包含两部分：
- **Kiro IDE 插件**（`agent-support/kiro/`）：检测 AI 编辑、记录代码归属、上报指标
- **Dashboard 服务**（`agent-support/kiro-dashboard/`）：接收指标、用户管理、数据展示

## 本 Session 完成的功能修改

### 1. ai_deletions 精确计算

**问题**：`total_ai_deletions` 包含过程中数据（AI 删了又恢复也计入），不精确。

**方案**：
- hook 脚本从 `git-ai diff --json` 的 `commits.authorship_note` 中提取 AI prompt 的 `total_deletions`（策略1）
- 从 hunks 中统计有 `prompt_id` 的 deletion 行数（策略2，覆盖 AI 创建的文件被删除场景）
- 取两者较大值，cap 到 `git_diff_deleted_lines`
- 优先使用插件端计算的 `kiro_net_deletions`（精确值）

**关键修复**：
- authorship_note 解析：用 `indexOf('---')` 而非 `startsWith('---')`（note 前可能有注解行）
- `kiro_net_deletions` 计算移到 `checkpointedActions` 过滤之前（基于完整 writeActions）
- Windows `originalContent === modifiedContent` 时从磁盘读取实际行数

**文件**：`gitUtils.ts`（hook 脚本）、`sessionLogWatcher.ts`（kiro_net_deletions 写入）

### 2. ai_additions 去除 mixed_additions

**需求**：客户要求上报的 `ai_additions` 只含纯 AI 行数。

**实现**：hook 脚本中 `ai_additions -= mixed_additions`。

### 3. ai_additions/ai_accepted/human_additions cap

**问题**：复杂修改（rename + 修改）可能导致这些值超过 `git_diff_added_lines`。

**实现**：hook 脚本中三个值都 cap 到 `git_diff_added_lines`（仅 > 0 时生效）。

### 4. delete action 兼容

**问题**：Kiro 的 delete action 的 `actionState` 是 `"Success"` 而非 `"Accepted"`。

**修复**：`sessionLogParser.ts` 对 `actionType=delete` 同时接受 `Success` 状态。

### 5. 父目录 workspace 支持

**问题**：workspace 是 git 项目的父目录时，checkpoint 路由错误。

**修复**：
- `gitUtils.ts` 新增 `findGitReposInDir()` 扫描子目录找 git repos
- `sessionLogWatcher.ts` 的 `discoverReposFallback()` 三级查找：findGitRoot → findGitReposInDir → workspace fallback
- `installHooksForWorkspace()` 也加了子目录扫描
- `initRepoDiscovery` 对 git extension 返回的 repos 做 `.git/HEAD` 验证
- `findGitRoot` 验证 `.git/HEAD` 存在（防止假 `.git` 目录误判）

### 6. Windows 绝对路径兼容

**问题**：Windows 上 Execution Log 中 `file` 字段有时是绝对路径，且盘符大小写不一致。

**修复**：workspace 过滤逻辑中：
- 绝对路径自动转为 workspace-relative
- `startsWith` 比较改为大小写不敏感（`.toLowerCase()`）

### 7. Windows PowerShell 兼容

**修复**：
- `Join-Path` 改为嵌套调用（PS 5.x 只支持 2 参数）
- 强制 TLS 1.2：`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`
- ps1 路径使用反斜杠，powershell.exe 使用完整路径 + fallback

### 8. Windows 改名后 AI 修改

**问题**：`originalContent === modifiedContent` 时跳过 human checkpoint，导致整个文件归 AI。

**修复**：不再跳过 human checkpoint，始终用 `originalContent` 作为基线。

### 9. URL/Token 硬编码

**修改**：
- 删除 `statsUploadUrl`、`statsUploadToken`、`statsApiPath`、`userSyncApiPath` 配置项
- 新建 `apiConfig.ts` 集中管理硬编码 URL
- Dashboard 端去掉 auth 校验

### 10. plugins 表主键改 hostname

**修改**：`mac_address` → `hostname`（`os.hostname()`），解决同一设备多网卡多条记录问题。

### 11. userSync 改进

- IP 获取改为 `os.networkInterfaces()`（不再调外部 HTTP）
- 定时间隔改为 4 小时
- payload 写入所有发现的 git repo 的 `last_upload_payload.json`

### 12. 调试输出

- stats 和 userSync 的 payload 统一追加到 `.git/ai/last_upload_payload.json`（JSONL 格式，带时间戳）
- 15 天前的记录自动清理

### 13. Linux x64 二进制

- 用 zig 交叉编译 Linux x64 版本，放入 `bin/git-ai-linux`
- `checkpoint.ts` 的 `initBundledBinary` 支持三平台：darwin → `git-ai`，win32 → `git-ai.exe`，linux → `git-ai-linux`

### 14. SOW 文档和测试计划

- `task.md`：更新 SOW，Dashboard 改为 API 接口文档
- `manual-test-plan.md`：60 个测试用例，覆盖所有场景
- `architecture-flow.drawio`：简化流程图
- `aws-integration.md`：AWS SDK 集成配置文档

## 已知限制

1. **IDE 自动重构不被追踪**：文件改名时 IDE 自动修改类名不经过 Kiro Execution Log，归属不确定
2. **Kiro IDE 无 vscode.git extension**：CommitWatcher 在 Kiro IDE 中不工作（git extension 不存在）
3. **mixed_additions 精确性**：依赖 git-ai 核心的 `overriden_lines` 计算，插件端无法改善
4. **AI 删除人工创建的文件**：如果文件没有 AI checkpoint 归属数据，删除时 `prompt_id` 为空，需要依赖 `kiro_net_deletions` 或 `total_deletions`

## 关键文件清单

| 文件 | 职责 |
|------|------|
| `src/apiConfig.ts` | 硬编码的 Dashboard API URL |
| `src/checkpoint.ts` | 二进制初始化（三平台）、checkpoint 调用 |
| `src/sessionLogWatcher.ts` | AI 编辑检测、checkpoint 路由、kiro_net_deletions |
| `src/sessionLogParser.ts` | Execution Log 解析（Format A/B、delete action） |
| `src/gitUtils.ts` | findGitRoot、findGitReposInDir、hook 安装、hook 脚本生成 |
| `src/userSync.ts` | 用户信息上报（email/IP/hostname）、定时机制 |
| `src/commitWatcher.ts` | commit 检测（依赖 vscode.git） |
| `src/repoRouter.ts` | WriteAction 按 repo 分组、路径转换 |
| `src/workspacePathEncoder.ts` | workspace 路径编码、类型定义 |

## 打包命令

```bash
cd agent-support/kiro
npx tsc -p ./
npx vsce package
# 输出: git-ai-kiro-0.1.2.vsix
```

## 交叉编译 Linux 二进制

```bash
# 需要 zig 和 x86_64-unknown-linux-gnu target
# 创建 wrapper 脚本过滤 --target 参数
CC_x86_64_unknown_linux_gnu="./zig-cc-x86_64-linux.sh" \
AR_x86_64_unknown_linux_gnu="zig ar" \
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="./zig-linker-x86_64-linux.sh" \
cargo build --release --target x86_64-unknown-linux-gnu

cp target/x86_64-unknown-linux-gnu/release/git-ai agent-support/kiro/bin/git-ai-linux
```

zig-cc-x86_64-linux.sh 内容：
```bash
#!/bin/sh
args=""
for arg in "$@"; do
  case "$arg" in
    --target=*) ;;
    *) args="$args $arg" ;;
  esac
done
exec zig cc -target x86_64-linux-gnu $args
```
