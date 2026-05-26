# 源码速查表

客户支持时分析代码的两种方式：

1. **客户机本地**（推荐，离线可用）：客户安装的插件 VSIX 自带 `support-sources/` 目录，包含核心源码副本
   - macOS/Linux: `~/.kiro/extensions/git-ai.git-ai-kiro-<version>/support-sources/`
   - Windows: `%USERPROFILE%\.kiro\extensions\git-ai.git-ai-kiro-<version>\support-sources\`
2. **GitHub 实时**：从主仓库拉最新版本（适合验证 bug 是否已修复）
   - 仓库：`https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock`
   - Raw URL：`https://raw.githubusercontent.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock/main/<path>`

下面表中的 `<path>` 在 GitHub 和 `support-sources/` 中相同。

---

## 模块 1：SessionLogWatcher（监听 Kiro execution log）

| 文件 | 关键函数 | 主要职责 |
|------|---------|---------|
| `kiro-plugin/src/sessionLogWatcher.ts` | `start()` / `processExecutionLog()` | 监听文件变化、解析 log、调度 checkpoint |
| `kiro-plugin/src/sessionLogParser.ts` | `parseExecutionLog()` / `extractFormatAWriteActions()` / `extractFormatBWriteActions()` | 两种格式解析 |
| `kiro-plugin/src/sessionLogScanner.ts` | `getWorkspaceSessionIds()` | workspace 隔离 |
| `kiro-plugin/src/checkpointPayload.ts` | `buildCheckpointPayload()` | 构建 git-ai checkpoint 输入 |
| `kiro-plugin/src/repoRouter.ts` | `findRepoForFile()` / `groupActionsByRepo()` / `toRepoRelativePath()` | 多 repo 路由（**Windows 大小写敏感问题在此**） |
| `kiro-plugin/src/workspacePathEncoder.ts` | `WriteAction` interface 定义 | 数据类型 |

**Format A 字段**（execution log）：
- `actions[].actionType`：`replace` / `create` / `write` / `append` / `editCode` / `delete` / `smartRelocate`
- `actions[].actionState`：必须是 `"Accepted"`
- `actions[].input.file` / `originalContent` / `modifiedContent` / `emittedAt`

**Format B 字段**：
- `context.messages[].toolUse`
- 工具白名单：`fsWrite` / `strReplace` / `fsAppend` / `deleteFile`
- 同 id 的 `toolUseResponse.success` 必须是 `true`

---

## 模块 2：Git Hook（post-commit / pre-commit）

| 文件 | 关键函数 | 主要职责 |
|------|---------|---------|
| `kiro-plugin/src/gitUtils.ts` | `installPreCommitHook()` / `installPostCommitHook()` / `buildHookSectionUnix()` / `buildHookSectionWindows()` | 生成并安装 hook 脚本 |
| `kiro-plugin/src/gitUtils.ts` | `findGitRoot()` / `findGitReposInDir()` | repo 发现 |
| `kiro-plugin/src/gitUtils.ts` | `canRunShOnWindows()` / `canRunPowerShellHere()` / `findPowerShellExe()` | Windows 平台探测 |
| `kiro-plugin/src/checkpoint.ts` | `callCheckpointAgentV1()` | 调用 git-ai checkpoint（**路径分隔符统一在此**） |
| `kiro-plugin/src/apiConfig.ts` | `STATS_URL` / `USER_SYNC_URL` | dashboard endpoint |

**Hook 关键逻辑速查**：

```sh
# pre-commit hook（buildHookSectionUnix 中段）
taskkill //F //IM git-ai.exe || pkill -x git-ai || true   # 清残留进程
"<binaryPath>" checkpoint human                            # 触发 human checkpoint

# post-commit hook 主体（amend 检测）
REFLOG_MSG=$(git reflog -1 --format=%gs HEAD)
case "$REFLOG_MSG" in *"commit (amend)"*) IS_AMEND=1 ;; esac
if [ "$IS_AMEND" = "1" ]; then
  OLD_SHA=$(git rev-parse -q --verify "HEAD@{1}")           # 注意：不能用 ORIG_HEAD
  AMEND_ARGS=" --amend-from $OLD_SHA"
fi
"<binaryPath>" post-commit "$COMMIT_SHA"$AMEND_ARGS

# stats 计算 + 上报
"<binaryPath>" stats "$COMMIT_SHA" --json --ignore "..."
"<binaryPath>" diff "$COMMIT_SHA" --json
# ... AI/HUMAN deletion 计算 ...
# 写 PAYLOAD 到临时文件，curl -d @file 发送
```

---

## 模块 3：userSync (Activity Reporter)

| 文件 | 关键函数 | 主要职责 |
|------|---------|---------|
| `kiro-plugin/src/userSync.ts` | `start()` / `maybeDoUserSync()` / `doUserSync()` | userSync 触发与上报 |
| `kiro-plugin/src/userSync.ts` | `stripIdentityStorePrefix()` | 剥离 `d-<storeId>.` 前缀 |
| `kiro-plugin/src/qClientWatcher.ts` | `QClientLogWatcher.start()` / `extractLatestUserId()` | 监听 q-client.log 中的 GetUsageLimitsCommand |

**关键逻辑**：
- 4 小时去重（看 `last_upload_payload.json` 中最近的 `[userSync]` 时间戳）
- `isFirst` 标志：插件启动后第一次 GetUsageLimitsCommand 必上报
- email 来源优先级：`kiro-cli whoami` → "Unknown" + user_id（dashboard 解析）

---

## 模块 4：git-ai（Rust 二进制，被插件调用）

git-ai 是嵌入插件的 Rust 二进制，在 `git-ai-src/` 子目录。客户机上只有打包好的 `.exe` / 二进制文件。

| 文件 | 关键函数 | 主要职责 |
|------|---------|---------|
| `git-ai-src/src/commands/git_ai_handlers.rs` | `handle_post_commit()` | 处理 `git-ai post-commit <SHA> [--amend-from <SHA>]` 命令 |
| `git-ai-src/src/authorship/post_commit.rs` | `post_commit()` / `post_commit_with_final_state()` | 普通 commit 的 authorship 生成 |
| `git-ai-src/src/authorship/rebase_authorship.rs` | `rewrite_authorship_after_commit_amend_with_snapshot()` / `rewrite_authorship_if_needed()` | amend / rebase 处理 |
| `git-ai-src/src/authorship/virtual_attribution.rs` | `from_just_working_log()` / `to_authorship_log_and_initial_working_log()` | 行级归属计算（**空行间隙修复在此**） |
| `git-ai-src/src/authorship/attribution_tracker.rs` | `attributions_to_line_attributions()` / `fill_blank_line_gaps_between_ai_ranges()` | 字符级 → 行级转换 |
| `git-ai-src/src/git/rewrite_log.rs` | `RewriteLogEvent::Commit` / `RewriteLogEvent::CommitAmend` | rewrite 事件类型（amend 路径） |

**git-ai CLI 命令速查**：
```
git-ai checkpoint human            # 创建 human checkpoint（pre-commit 调用）
git-ai checkpoint agent-v1         # 创建 AI checkpoint（插件 SessionLogWatcher 调用）
git-ai post-commit <SHA>           # 普通 commit 处理
git-ai post-commit <SHA> --amend-from <ORIG_SHA>   # amend 处理（0.1.6+）
git-ai stats <SHA> --json --ignore "..."
git-ai diff <SHA> --json
git-ai notes --ref=ai show <SHA>   # 不存在；用 git notes
```

---

## 拉取源码示例

```bash
# 客户机上：直接读 support-sources（macOS）
cat ~/.kiro/extensions/git-ai.git-ai-kiro-*/support-sources/kiro-plugin/src/sessionLogWatcher.ts

# 客户机上：直接读 support-sources（Windows PowerShell）
Get-Content "$env:USERPROFILE\.kiro\extensions\git-ai.git-ai-kiro-*\support-sources\kiro-plugin\src\sessionLogWatcher.ts"

# 远程：从 GitHub 拉最新版（验证是否已修复）
web_fetch https://raw.githubusercontent.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock/main/kiro-plugin/src/sessionLogWatcher.ts
```

**注意**：
- `support-sources/` 是打包时刻的快照，可能落后于 GitHub main 分支。客户用的版本就以本地为准。
- 客户机上 `out/` 目录是编译后的 JS，行号要对应到 `support-sources/kiro-plugin/src/<file>.ts` 而非 `out/<file>.js`。
