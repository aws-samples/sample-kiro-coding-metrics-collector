# 流水线症状定位手册

按用户报告的**症状**，索引到流水线哪个阶段，列出该阶段的关键证据和验证方法。

不要直接给"建议"——先把范围缩小到 1-2 个阶段。

---

## 流水线全景（再贴一遍）

```
[阶段 0]  Kiro IDE AI 编辑文件
            ↓ 写入 execution log（globalStorage/.../<execution-id>）
[阶段 1]  SessionLogWatcher 监听 + 解析（Format A / Format B）
            ↓ WriteAction[]
[阶段 2]  groupActionsByRepo（路径归一化、按 repo 分组）
            ↓ 每 repo 一组 actions
[阶段 3]  buildCheckpointPayload + callCheckpointAgentV1
            ↓ git-ai checkpoint agent-v1 调用
[阶段 4]  git-ai 写 .git/ai/working_logs/<base_sha>/checkpoints.jsonl
            ↓
[阶段 5a] 用户 git commit → pre-commit hook（git-ai checkpoint human）
            ↓
[阶段 5b] post-commit hook（git-ai post-commit + stats + diff）
            ↓ 写 git note refs/notes/ai
[阶段 5c] hook 拼 PAYLOAD → curl POST → last_upload_payload.json 追加 + dashboard
[阶段 6]  Dashboard 入库 + 展示
```

---

## 症状 → 阶段 索引表

### 类别 A：上报数据错（dashboard 上看到的数值不对）

| 症状 | 优先排查阶段 | 关键证据 |
|------|------------|---------|
| `ai_additions=0`（应有 AI 编辑） | 阶段 1→3→4→5b | execution log 是否有对应 actions / working_logs/<sha>/INITIAL / git note prompts |
| `human_additions` 偏多（应全是 AI） | 阶段 4→5b | working_logs/<sha>/INITIAL 中 line ranges / git note 中 accepted_lines |
| `ai_deletions` 不对 | 阶段 1→5c | `.git/ai/kiro_net_deletions` / `git-ai diff <sha> --json` 输出 |
| amend commit 后归属丢失 | 阶段 5b | `git reflog`、`HEAD@{1}` vs `ORIG_HEAD`、hook 中 `--amend-from` 参数 |
| 跨 commit AI 行未传递 | 阶段 4 | working_logs/<parent>/INITIAL 是否有上次未提交的 AI 行 |
| commit_msg 乱码或缺失 | 阶段 5c | hook 中 commit_msg 处理片段、payload 文件字节 |
| dashboard 上完全没有数据 | 阶段 5c→6 | last_upload_payload.json 是否有记录 / curl 是否成功 |

### 类别 B：插件没反应

| 症状 | 优先排查阶段 | 关键证据 |
|------|------------|---------|
| DevTools Console 完全没 [git-ai-kiro] 日志 | 阶段 0 之前 | 插件是否激活（package.json activationEvents） |
| 有日志但停在某阶段 | 看停在哪 | 阶段 1：parse 失败；阶段 2：Skipping/Orphan；阶段 3：spawn 失败 |
| Skipping (sessionId mismatch) | 阶段 1 | sessions.json / chatSessionId |
| Skipping file outside workspace | 阶段 2 | workspace 路径 vs 文件路径，多根 workspace 配置 |
| Orphan file (no matching repo) | 阶段 2 | this.repos 列表 / git repo 实际位置 |
| Skipping non-existent file | 阶段 2 | path.resolve 后的绝对路径 / 是否 sibling repo |

### 类别 C：post-commit hook 失败

| 症状 | 优先排查阶段 | 关键证据 |
|------|------------|---------|
| hook 文件不存在 | 阶段 4 之前 | 插件 `installPostCommitHook` 是否调到 / repo 是否在递归扫描范围内 |
| hook 执行报错 | 阶段 5b/5c | 手动跑 `sh .git/hooks/post-commit` 看 stderr |
| `git-ai post-commit` exit code != 0 | 阶段 5b | git-ai stderr / post_commit_debug.log |
| stats 上报失败（curl 错） | 阶段 5c | 手动跑 curl / 检查 dashboard URL / 网络连通性 |
| commit_msg 中文导致 curl 失败 | 阶段 5c | 看 .payload.tmp 的字节序列 |

### 类别 D：userSync 异常

| 症状 | 优先排查阶段 | 关键证据 |
|------|------------|---------|
| 不上报 | userSync.ts | qClientWatcher 是否触发 / last_upload_payload.json 中 [userSync] 时间戳 |
| 频繁上报 | userSync.ts | 4h 去重逻辑、isFirst 状态 |
| user_id 异常（含敏感前缀） | userSync.ts | stripIdentityStorePrefix 是否生效 |
| email 是 "Unknown" | userSync.ts | kiro-cli whoami 是否可用 / dashboard 解析逻辑 |

---

## 每个阶段的关键证据清单

### 阶段 0 — Kiro execution log

**位置**：
- macOS: `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/<hash>/<workspace-hash>/<execution-id>`
- Windows: `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\<...>\<...>\<...>`

**关键字段**（Format A）：
- `actions[].actionType` ∈ {replace, create, write, append, editCode, delete, smartRelocate}
- `actions[].actionState === "Accepted"` 必需
- `actions[].input.file` / `originalContent` / `modifiedContent`
- `actions[].emittedAt`
- `chatSessionId`

**典型异常**：
- `actionState === "Rejected"` 或 `"Pending"` → 用户取消了 AI 操作，不应被插件记录
- 缺少 `originalContent` → Format B（toolUse），需要插件按工具名映射
- `chatSessionId` 不在当前 workspace 的 sessions.json → 跨 workspace 串扰

### 阶段 1 — SessionLogWatcher 解析

**关键日志**（DevTools Console）：
```
[git-ai-kiro] File changed: <hash>, size: X → Y
[git-ai-kiro] Parsed <hash>: format=A/B, actions=N, sessionId=..., endTime=...
[git-ai-kiro] Skipped (sessionId mismatch): ...
[git-ai-kiro] Skipped (no chatSessionId): ...
```

**典型异常**：
- `actions=0` 但用户确实编辑了 → log format 不识别 / actionState 不是 Accepted
- `sessionId mismatch` → workspace 隔离机制把当前 log 拒了；可能是 sessions.json 没刷新

### 阶段 2 — 路径分组（groupActionsByRepo）

**关键日志**：
```
[git-ai-kiro] Processing N write action(s) from: ...
[git-ai-kiro]   action: replace, file: X, original: Y chars / Z lines, modified: ...
[git-ai-kiro] Skipping file outside workspace: ...
[git-ai-kiro] Orphan file (no matching repo): ...
[git-ai-kiro] Re-routed file to sibling repo: X → Y
[git-ai-kiro] Dynamically discovered sibling repo: ...
```

**关键代码**（GitHub）：
- `kiro-plugin/src/repoRouter.ts::findRepoForFile` — Windows 大小写不敏感
- `kiro-plugin/src/repoRouter.ts::toRepoRelativePath` — `path.resolve` 处理 `..`
- `kiro-plugin/src/sessionLogWatcher.ts` 的 filter + re-route 块

**典型异常**：
- 文件路径以 workspace 父目录的目录名开头（如 workspace 是 `barcm`，filePath 是 `barcm/code/...`）→ 路径解析多嵌一层
- Windows 盘符大小写不一致（D: vs d:）→ `startsWith` 匹配失败
- `Re-routed` 后的箭头 `→` 后面是绝对路径而非相对 → repo-relative 计算失败

### 阶段 3 — checkpoint 调用

**关键日志**：
```
[git-ai-kiro] Sending AI checkpoint for repo X: edited_filepaths=[...], dirty_files keys=[...]
[git-ai-kiro] Spawning: <binaryPath> checkpoint agent-v1 --hook-input stdin (cwd: ...)
[git-ai-kiro] Payload size: N bytes
[git-ai-kiro] git-ai stderr: ...
[git-ai-kiro] git-ai exited with code N
```

**典型异常**：
- `git-ai stderr: Failed to find any git repositories. Orphaned files: [...]` → cwd + filepath 拼接出问题（Windows 反斜杠/正斜杠混合）
- `Payload size: 0 bytes` → buildCheckpointPayload 返回空
- spawn 失败 → 二进制路径不对 / 权限不足

### 阶段 4 — working_logs

**位置**：`<repo>/.git/ai/working_logs/<base_sha>/`

**结构**：
```
working_logs/<base_sha>/
├── INITIAL                  # 跨 commit 传递的 AI 归属
├── checkpoints.jsonl        # 每次 checkpoint 的 raw 记录
└── blobs/<content_hash>     # 文件内容快照
```

**INITIAL 关键字段**：
- `files.<path>[].start_line/end_line/author_id`
- `prompts.<author_id>.accepted_lines`（session 累计）

**checkpoints.jsonl 关键字段**：
- `kind` ∈ {AiAgent, Human}
- `entries[].file/line_attributions[]/attributions[]`

**典型异常**：
- INITIAL 不存在但应该有（commit 1 部分提交后，commit 2 没继承） → checkpoint 没把未提交的 AI 行写进 INITIAL
- checkpoints.jsonl 行数不增加 → checkpoint 调用失败或被吞
- `kind=Human` checkpoint 的 `line_attributions` 远少于 INITIAL 的范围 → AI 行被空行拆段

### 阶段 5a — pre-commit hook

**位置**：`<repo>/.git/hooks/pre-commit`

**主要内容**：
```sh
taskkill //F //IM git-ai.exe || pkill -x git-ai || true   # 清残留进程
"<binaryPath>" checkpoint human                            # 触发 human checkpoint
```

**典型异常**：
- 文件不存在 → 插件没安装 hook
- 没有执行权限（非 Windows）→ chmod 0o755 失败
- husky/lefthook 把 hook 覆盖了

### 阶段 5b — post-commit hook 主体

**关键证据**：
- `<repo>/.git/ai/post_commit_debug.log` 中本次 commit 的块
  - `commit=`, `parent=`, `va_files=[...]`, `checkpoints=[...]`, `pathspecs={...}`, `has_unresolved=true/false`
  - `to_authorship_log: attr_keys=[...] committed_hunks_keys=[...]`
- `git -C <repo> notes --ref=ai show <sha>` 输出
  - `prompts: {}` 为空 = 没归属任何 AI prompt
  - `prompts.<id>.accepted_lines` = 该 prompt 累计接受行数

**关键代码**（GitHub）：
- `git-ai-src/src/commands/git_ai_handlers.rs::handle_post_commit` — `--amend-from` 处理
- `git-ai-src/src/authorship/post_commit.rs::post_commit` — 普通提交路径
- `git-ai-src/src/authorship/rebase_authorship.rs::rewrite_authorship_after_commit_amend_with_snapshot` — amend 路径
- `git-ai-src/src/authorship/virtual_attribution.rs::to_authorship_log_and_initial_working_log` — 行级归属计算

### 阶段 5c — stats 计算 + 上报

**关键证据**：
- `git-ai stats <sha> --json` 手动跑的输出
- `git-ai diff <sha> --json` 输出（含 hunks 和 prompt_id）
- `<repo>/.git/ai/last_upload_payload.json` 中本次 commit 的 [stats] 行
- `<repo>/.git/ai/.payload.tmp`（如果上一次 hook 执行还没清理）

**典型异常**：
- `last_upload_payload.json` 中本次 commit 的 [stats] 行存在但 `ai_additions=0` → git note 已是空 prompts，问题在阶段 5b
- `[stats]` 行不存在 → curl 失败（看 stderr 或网络）
- payload 中 `commit_msg=""` 但实际有消息 → commit_msg 处理出问题

### 阶段 6 — Dashboard

**关键证据**：
- dashboard `/api/v1/stats` 接收日志
- SQLite `commits` 表中记录是否存在
- 前端是否调对接口

**典型异常**：
- dashboard 收到了但前端没显示 → 前端缓存或查询条件不对
- 完全没收到 → 上报阶段没成功

---

## 常用快速验证命令

```bash
# 看用户某个 commit 是否有 ai note
git -C <repo> notes --ref=ai show <sha>

# 看用户的最近 reflog（重要：amend 用 HEAD@{1} 取 OLD_SHA）
git -C <repo> reflog -10

# 检查 amend 真假
git -C <repo> reflog -1 --format=%gs HEAD   # 是否含 "commit (amend)"
git -C <repo> rev-parse "HEAD@{1}"           # OLD_SHA

# 看上报记录
tail -c 50000 <repo>/.git/ai/last_upload_payload.json | grep -oE '\[stats\] [^[]*' | tail -10

# 看 working_logs 最新状态
ls -la <repo>/.git/ai/working_logs/$(git -C <repo> rev-parse HEAD^)/

# 手动跑 stats / diff
<plugin-bin>/git-ai stats <sha> --json --ignore "..."
<plugin-bin>/git-ai diff <sha> --json | python3 -m json.tool | head -50

# 手动跑 hook
sh <repo>/.git/hooks/post-commit

# 看插件激活日志（DevTools Console）
# Help → Toggle Developer Tools → Console → 筛选 [git-ai-kiro]
```
