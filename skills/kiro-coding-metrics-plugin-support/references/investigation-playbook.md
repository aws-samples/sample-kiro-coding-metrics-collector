# 流水线症状定位手册

按用户报告的**症状**，索引到流水线哪个阶段，列出该阶段的关键证据和验证方法。

不要直接给"建议"——先把范围缩小到 1-2 个阶段。

---

## 流水线全景（再贴一遍）

```
[阶段 0]  Kiro IDE AI 编辑文件
            ↓ 旧版 Kiro：写 execution log（globalStorage/.../<execution-id>）
            ↓ Kiro 1.0：写 ~/.kiro/sessions/<workspace-hash>/sess_<uuid>/messages.jsonl
[阶段 1]  SessionLogWatcher 监听 + 解析（Format A / B = 旧版，Format C = Kiro 1.0）
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
| `ai_additions=0`（应有 AI 编辑） | 阶段 1→3→4→5b | 会话日志是否有对应 actions（**先确认 Format A/B 还是 C**）/ working_logs/<sha>/INITIAL / git note prompts |
| **AI 写的行全被算成 human，但 git note 看起来完全正常** | 阶段 5b **读取侧** | git-ai stderr 是否有 `authorship note for X exists but could not be parsed`——见下方「note 解析失败」专条 |
| `human_additions` 偏多（应全是 AI） | 阶段 4→5b | working_logs/<sha>/INITIAL 中 line ranges / git note 中 accepted_lines |
| **人工先写、AI 后改同一文件，人工的行被算进 AI** | 阶段 3 | Format C 下是否发了人工基线 checkpoint——见下方「Format C 缺人工基线」专条 |
| `ai_deletions` 不对 | 阶段 1→5c | `.git/ai/kiro_net_deletions` / `git-ai diff <sha> --json` 输出 |
| `mixed_additions` 恒为 0 | — | **已知缺陷，不要排查**。归因逻辑本身不产出该值，非环境问题 |
| amend commit 后归属丢失 | 阶段 5b | `git reflog`、`HEAD@{1}` vs `ORIG_HEAD`、hook 中 `--amend-from` 参数 |
| 跨 commit AI 行未传递 | 阶段 4 | working_logs/<parent>/INITIAL 是否有上次未提交的 AI 行 |
| commit_msg 乱码或缺失 | 阶段 5c | hook 中 commit_msg 处理片段、payload 文件字节 |
| dashboard 上完全没有数据 | 阶段 5c→6 | last_upload_payload.json 是否有记录 / curl 是否成功 |

### 类别 B：插件没反应

| 症状 | 优先排查阶段 | 关键证据 |
|------|------------|---------|
| DevTools Console 完全没 [git-ai-kiro] 日志 | 阶段 0 之前 | 插件是否激活（package.json activationEvents） |
| 有日志但停在某阶段 | 看停在哪 | 阶段 1：parse 失败；阶段 2：Skipping/Orphan；阶段 3：spawn 失败 |
| Skipping (sessionId mismatch) | 阶段 1 | sessions.json / chatSessionId（仅 Format A/B） |
| **升级 Kiro 后突然完全采不到 AI 数据** | 阶段 0-1 | 客户已升到 Kiro 1.0 但插件版本过旧、不支持 Format C。`ls ~/.kiro/sessions` 有内容而 Console 无 `format=C` 即可确认 |
| **Kiro 1.0：Console 没有任何 Format C 日志** | 阶段 0 | `~/.kiro/sessions` 是否存在；hash 目录下是否有 `sess_*/messages.jsonl`；注意 `cli` 子目录要跳过（那是 Kiro CLI 的会话，不属于 IDE） |
| **Kiro 1.0：发现了会话但归属不到当前 workspace** | 阶段 0 | `sess_*/session.json` 的 `workspacePaths` 数组与实际 workspace 路径是否匹配（Windows 上盘符大小写、分隔符差异是常见原因） |
| **长会话的数据整份丢失** | 阶段 0 | 会话文件体积。旧版上限 5 MB 会静默跳过整份会话，新版提升到 50 MB（40 MB 告警）。`ls -la` 看 `messages.jsonl` 大小 |
| **装插件之前那段对话没被采集** | 阶段 1 | 冷启动扫描窗口 7 天、单次上限 10 个文件。超窗口或超数量的历史会话不会补采，属预期行为 |
| Skipping file outside workspace | 阶段 2 | workspace 路径 vs 文件路径，多根 workspace 配置 |
| Orphan file (no matching repo) | 阶段 2 | this.repos 列表 / git repo 实际位置 |
| Skipping non-existent file | 阶段 2 | path.resolve 后的绝对路径 / 是否 sibling repo |

### 类别 C：post-commit hook 失败

| 症状 | 优先排查阶段 | 关键证据 |
|------|------------|---------|
| hook 文件不存在 | 阶段 4 之前 | 插件 `installPostCommitHook` 是否调到 / repo 是否在递归扫描范围内 |
| **`.git/hooks/` 下没有 hook，但插件日志说装了** | 阶段 4 之前 | `git config --get core.hooksPath`。企业环境常把它指向 git-defender 等工具目录，hook 装到了那里而不是 `.git/hooks/`——见下方「core.hooksPath」专条 |
| **Console 出现 `Refusing to modify non-text hook`** | 阶段 4 之前 | 目标 hook 是编译过的二进制（第三方工具装的），插件**有意跳过**不改写。此时靠扩展侧兜底上传，不是故障——见下方「core.hooksPath」专条 |
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

### 类别 E：性能问题（hook 慢 / 进程堆积 / IDE 卡顿）

性能症状有完整专题：参见 `references/performance-optimization.md`。这里只给入口索引：

| 症状 | 跳转章节 | 一句话判断 |
|------|---------|----------|
| `git commit` 命令在终端等 30s+ 才返回 | `performance-optimization.md` §3 setsid 后台化 | 看 hook 内是否有 `setsid -f` / `_gitai_kiro_body`，缺失则版本 < 0.2.9 |
| 同仓库 D 盘 commit ≫ C 盘 | `performance-optimization.md` §2 慢盘环境识别 | 让客户跑两次 `git diff --shortstat`，第二次明显快则是 cache 效应 |
| 任务管理器一堆 git-ai.exe | `performance-optimization.md` §5 进程治理 | 0.2.9+ 应该不再有；老版本是 hook 末尾 taskkill 导致 / 后端无锁导致 |
| 多对话框并发 AI 编辑后 IDE 卡 | `performance-optimization.md` §5.2 双层防护 | 看 checkpoint.ts 是否有 per-repo 队列、repo_storage.rs 是否有 fs2 advisory lock |
| 升级新版后部分客户变慢（部分客户变快） | `performance-optimization.md` §7 反优化教训 | 警惕 git diff 顺序改动导致 cache warming 丢失 |
| hook 总耗时远大于 GITAI-TIMING 各阶段之和 | `performance-optimization.md` §6 fork 风暴 | shell 端 `printf|sed` / `$(date)` 等子进程开销 |
| 客户报"hook 跑了半天"，问怎么诊断 | `performance-optimization.md` §8 GITAI-TIMING + §10 排查命令 | 直接让客户提供 post-commit-*.log 中的 `GITAI-TIMING:` 行 |

**性能症状必问环境信息**（Step 1 时一并问到）：

- 仓库所在卷类型（HDD / SSD / 网络盘 / 加密盘）
- Windows Defender 是否对仓库目录与 git-ai.exe 做了排除
- 是否有企业 EDR / DLP（CrowdStrike / Carbon Black 等）
- `package.json` 里的插件版本（性能时间线见 `performance-optimization.md` §9）

---

## 每个阶段的关键证据清单

### 阶段 0 — Kiro 会话日志（两套数据源，先分清是哪套）

| | 旧版 Kiro（Format A/B） | Kiro 1.0（Format C） |
|---|---|---|
| 位置 | `<globalStorage>/kiro.kiroagent/<hash>/<workspace-hash>/<execution-id>` | `~/.kiro/sessions/<workspace-hash>/sess_<uuid>/messages.jsonl` |
| 格式 | 单个 JSON 文档 | 逐行 JSON（JSONL） |
| workspace 归属 | 文件内 `chatSessionId` 对 `sessions.json` | `sess_*/session.json` 的 `workspacePaths` 数组 |
| 写入动作 | `actions[]` / `context.messages[]` | `payload.type === "tool_call"` + 配对的 `tool_result` |
| 文件体积上限 | 50 MB（旧插件版本是 5 MB，超限静默跳过整份会话） | 同左 |

**先执行这一步**：

```bash
ls ~/.kiro/sessions 2>/dev/null && echo "→ 按 Format C 排查" || echo "→ 按 Format A/B 排查"
```

`~/.kiro/sessions` 全平台同一路径（不像旧版 globalStorage 分三套平台路径）。

#### Format C 关键字段

- `payload.type` == `"tool_call"`，且对应 `toolCallId` 的 `tool_result.success === true`
- 准入条件：`payload.kind === "edit"` **或** `toolName` ∈ {`str_replace`, `write_file`, `create_file`, `delete_file`, `write_to_file`, `insert_code`, `fs_write`}
- 内容：`str_replace` 取 `oldStr` / `newStr`；其余取 `args.content ?? args.text`
- 行级 `timestamp`（ISO）→ `emittedAt`
- `conversation_id` 取 `sess_` 目录名

**Format C 典型异常**：
- `~/.kiro/sessions/<hash>/cli/` 下的会话被当成 IDE 会话 → 应跳过，`cli` 是 Kiro CLI 的
- `session.json` 的 `workspacePaths` 与扩展 API 的 `fsPath` 在 Windows 上盘符大小写/分隔符不一致 → 归属匹配失败，采不到任何数据
- `tool_call` 有但配对的 `tool_result.success` 不为 true → 该次编辑失败，**不应**计入
- `str_replace` 只给片段（`oldStr`/`newStr`）而非文件全文 → 插件会从磁盘补读全文；若补读失败会在 Console 打 `Format C: could not read file for dirty_files`

#### Format A/B 关键字段
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

Format C（Kiro 1.0）对应的日志形态不同 —— 走独立的 `processFormatCActions()` 管道，`format=C`，会话 ID 是 `sess_*` 目录名。它按字节偏移**增量**读取（只解析新增字节），所以看到的是"读了 N 字节新内容"而不是重解析全文。

**典型异常**：
- `actions=0` 但用户确实编辑了 → log format 不识别 / actionState 不是 Accepted（A/B）；`tool_result.success` 不为 true（C）
- `sessionId mismatch` → workspace 隔离机制把当前 log 拒了；可能是 sessions.json 没刷新（仅 A/B）
- **完全没有 `format=C` 日志而 `~/.kiro/sessions` 有内容** → 插件版本不支持 Format C，需升级；这是 Kiro 升级后"数据突然全断"的最常见原因

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
- 多对话框并发触发同一 repo 的 spawn 风暴 → 见 `performance-optimization.md` §5.2（前端 per-repo 队列 + 后端 fs2 文件锁）

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
taskkill //F //IM git-ai.exe || pkill -x git-ai || true   # 清残留进程（注：post-commit hook 在 0.2.9+ 已删除该行，pre-commit 保留）
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
- `<repo>/.git/ai/logs/post-commit-YYYY-MM-DD.log` 中的 `GITAI-TIMING:` 阶段计时（性能问题必看，详见 `performance-optimization.md` §8）

**关键代码**（GitHub）：
- `git-ai-src/src/commands/git_ai_handlers.rs::handle_post_commit` — `--amend-from` 处理
- `git-ai-src/src/authorship/post_commit.rs::post_commit` — 普通提交路径
- `git-ai-src/src/authorship/rebase_authorship.rs::rewrite_authorship_after_commit_amend_with_snapshot` — amend 路径
- `git-ai-src/src/authorship/virtual_attribution.rs::to_authorship_log_and_initial_working_log` — 行级归属计算

**0.2.9+ 新结构**：hook body 整体被 `_gitai_kiro_body()` 包裹，由 `setsid -f bash -c ...` 启动。看 hook 文件首行如果是 `_gitai_kiro_body() {` 而不是 `(`，就是新版结构（详见 `performance-optimization.md` §3）。

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
- 0.2.8+ 该阶段已被异步化，看到 hook 日志里有 `===== async upload begin =====` 和 `===== async upload end =====` 包裹是正常的

### 阶段 6 — Dashboard

**关键证据**：
- dashboard `/api/v1/stats` 接收日志
- SQLite `commits` 表中记录是否存在
- 前端是否调对接口

**典型异常**：
- dashboard 收到了但前端没显示 → 前端缓存或查询条件不对
- 完全没收到 → 上报阶段没成功

---

## 三个症状指向错误方向的专条

这三类的共同点：**表面证据看起来都是正常的**，按常规路径排查会走进死胡同。遇到对应症状直接跳到这里。

### 专条 1 — note 解析失败（AI 行全被算成 human）

**症状**：dashboard 上 `ai_additions=0` / `human_additions` 等于全部新增行，但 `git notes --ref=ai show <sha>` 打开一看**完全正常** —— 归属区间在、`total_additions` 对、`accepted_lines` 对。

**根因**：读取侧反序列化失败。`get_authorship()` 拿到 note 内容但解析不了，返回 `None`，调用方于是认为该提交没有任何 AI 归因，把 AI 写的行全部计入 `human_additions`。

**最常见诱因**：客户机上装过**更新版本**的 git-ai（如 1.6.22），它写出的 note 省略了某些本版本视为必填的字段（典型是 `messages`）。note 是 git 对象，会随 push/fetch 传播 —— 即使客户后来卸载了那个版本，**已写进 `refs/notes/ai` 的 note 依然在**。

**判定命令**：

```bash
# 1. 看 git-ai stderr 有没有告警（关键证据）
<plugin-bin>/git-ai stats <sha> --json 2>&1 >/dev/null | grep 'could not be parsed'

# 2. 看这条 note 是哪个版本写的
git -C <repo> notes --ref=ai show <sha> | grep git_ai_version

# 3. 全仓库扫一遍，看有多少 note 来自更新的版本
git -C <repo> notes --ref=ai list | awk '{print $2}' | while read -r c; do
  git -C <repo> notes --ref=ai show "$c" 2>/dev/null | grep -o '"git_ai_version": "[^"]*"'
done | sort | uniq -c
```

若 stderr 有 `authorship note for X exists but could not be parsed`，证据链就完整了 —— **代码问题**，需要在读取侧对缺失字段做容错，不是环境问题，客户侧无法自行修复。

### 专条 2 — Format C 缺人工基线（人工的行被算成 AI）

**症状**：同一文件，**人工先写若干行、AI 随后改其中一行**，结果全部行都算给 AI（`human_additions=0`）。反向顺序（AI 先写、人工后改）不受影响。

**根因**：Format C 管道只下发 AI checkpoint，没有下发人工基线 checkpoint（Format A/B 走 `buildHumanPayload` 会先发一次人工基线，建立"AI 编辑前"的状态）。Format C 的 `dirty_files` 是从磁盘读的**全文快照**，里面已经包含人工先写的内容，于是这些行一并被归给 AI。

**判定方法**：

```bash
# 看这次 commit 的 checkpoints.jsonl 里有没有 kind=Human 的记录
grep -o '"kind":"[^"]*"' <repo>/.git/ai/working_logs/$(git -C <repo> rev-parse HEAD^)/checkpoints.jsonl | sort | uniq -c
```

Format C 场景下只看到 `AiAgent` 而没有 `Human`，就是这个缺陷。**代码问题，已知**，客户侧无解，只能说明现状。

对照实验（用来向客户/开发者证明）：在人工编辑后先手动跑一次 `sh .git/hooks/pre-commit`（它会触发 `git-ai checkpoint human`），再让 AI 编辑、再 commit —— 归属就正确了。这个差异本身就是证据。

### 专条 3 — core.hooksPath 与非文本 hook

**症状**：插件日志说 hook 装好了，但 `.git/hooks/post-commit` 不存在；或者 Console 里出现 `Refusing to modify non-text hook at <path>`。提交后没有上报。

**根因**：`core.hooksPath` 被配置指向了别处（企业环境里常指向 git-defender 一类安全工具的目录）。插件会**尊重**这个配置，把 hook 装到那里而不是 `.git/hooks/`。若目标位置已有一个**编译过的二进制** hook，插件会主动拒绝改写（避免破坏第三方工具），并跳过安装。

**判定命令**：

```bash
# 1. 实际生效的 hooks 目录
git -C <repo> config --get core.hooksPath
git -C <repo> rev-parse --git-path hooks

# 2. 系统级/全局级是否有设置（企业镜像常在这两层）
git config --system --get core.hooksPath
git config --global --get core.hooksPath

# 3. 目标 hook 是不是文本
file "$(git -C <repo> config --get core.hooksPath)/post-commit"

# 4. 是否显式禁用了 hooks
#    core.hooksPath 为 /dev/null 或 NUL 时插件识别为用户主动禁用，不会安装
```

**处理方向**：

- hook 装到了 `core.hooksPath` 指的目录 → 不是故障，去那个目录找 hook 验证内容
- 目标是非文本 hook 被跳过 → **不是故障**，插件此时依赖扩展侧兜底上传。验证兜底是否生效：看 Console 有没有扩展侧的上传日志，以及 `last_upload_payload.json` 是否仍在追加 `[stats]` 记录
- 若兜底也没有记录 → 才是真问题，回到阶段 5c 排查

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

# === Kiro 1.0 / Format C ===

# 是不是 Kiro 1.0 的数据源
ls ~/.kiro/sessions 2>/dev/null && echo "→ Format C" || echo "→ Format A/B"

# 列出当前 workspace 对应的会话（注意跳过 cli 子目录）
find ~/.kiro/sessions -maxdepth 2 -name 'sess_*' -type d 2>/dev/null | grep -v '/cli/' | head -10

# 看某个会话归属哪个 workspace（路径不匹配是采不到数据的常见原因）
cat ~/.kiro/sessions/<hash>/sess_<uuid>/session.json | python3 -m json.tool | grep -A5 workspacePaths

# 会话文件大小（超上限会整份被跳过）
ls -la ~/.kiro/sessions/<hash>/sess_<uuid>/messages.jsonl

# 看最后几个写入动作
tail -5 ~/.kiro/sessions/<hash>/sess_<uuid>/messages.jsonl | python3 -c 'import sys,json;[print(json.loads(l).get("payload",{}).get("type"),json.loads(l).get("payload",{}).get("toolName")) for l in sys.stdin]'

# === note 解析失败（专条 1）===

# 关键证据：stderr 的告警
<plugin-bin>/git-ai stats <sha> --json 2>&1 >/dev/null | grep 'could not be parsed'

# 这条 note 是哪个版本写的
git -C <repo> notes --ref=ai show <sha> | grep git_ai_version

# === core.hooksPath（专条 3）===

git -C <repo> config --get core.hooksPath
git -C <repo> rev-parse --git-path hooks
git config --system --get core.hooksPath; git config --global --get core.hooksPath

# === 人工基线是否存在（专条 2）===

grep -o '"kind":"[^"]*"' <repo>/.git/ai/working_logs/$(git -C <repo> rev-parse HEAD^)/checkpoints.jsonl | sort | uniq -c

# === 性能相关（详见 performance-optimization.md §10）===

# 看 hook 是否是 0.2.9+ 新版（含 setsid 启动逻辑）
grep -E "setsid -f|_gitai_kiro_body|flock -n 200" <repo>/.git/hooks/post-commit

# 看 GITAI-TIMING 各阶段
grep 'GITAI-TIMING:' <repo>/.git/ai/logs/post-commit-*.log | tail -20

# 看 flock 是否生效
grep 'acquired post-commit lock\|skipped due to lock' <repo>/.git/ai/logs/post-commit-*.log
```
