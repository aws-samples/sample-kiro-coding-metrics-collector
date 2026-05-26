# 架构数据流

理解三大模块的数据流，便于定位问题在哪一环。

---

## 整体架构

```
┌─────────────────────────────────────────────┐
│              Kiro IDE (前端)                 │
│  AI 编辑文件 → 写 execution log              │
└──────────────┬──────────────────────────────┘
               │ 文件变化
               ▼
┌─────────────────────────────────────────────┐
│  SessionLogWatcher (TS, 插件主进程)          │
│  1. fs.watch 监听 globalStorage 目录          │
│  2. 解析 execution log（Format A/B）         │
│  3. 按 repo 分组、过滤 ignore patterns       │
│  4. 调 git-ai checkpoint agent-v1            │
└──────────────┬──────────────────────────────┘
               │ stdin JSON
               ▼
┌─────────────────────────────────────────────┐
│  git-ai (Rust 二进制)                        │
│  写 .git/ai/working_logs/<base_sha>/         │
│  ├── checkpoints.jsonl (本次 AI 操作)        │
│  └── blobs/<hash> (文件快照)                 │
└──────────────┬──────────────────────────────┘
               │
   ┌───────────┴───────────┐
   ▼                       ▼
[用户 git commit]       [Kiro 调 GetUsageLimits]
   │                       │
   ▼                       ▼
┌─────────────┐     ┌─────────────────────┐
│ post-commit │     │ qClientWatcher 监听  │
│ hook (sh)   │     │ q-client.log         │
└──────┬──────┘     └──────┬──────────────┘
       │                   │
       ▼                   ▼
┌─────────────┐     ┌─────────────────────┐
│ git-ai      │     │ userSync.ts         │
│ post-commit │     │ - kiro-cli whoami   │
│ + stats     │     │   或 user_id 兜底    │
│ + diff      │     │ - 4h 去重            │
└──────┬──────┘     └──────┬──────────────┘
       │                   │
       │ POST /api/v1/stats│ POST /api/v1/userSync
       ▼                   ▼
┌─────────────────────────────────────────────┐
│       Dashboard (Node.js)                   │
│       SQLite + 前端展示                      │
└─────────────────────────────────────────────┘
```

---

## 模块 1：SessionLogWatcher 数据流

```
Kiro 写 execution log
   │
   ▼
fs.watch 触发 (debounced)
   │
   ▼
parseExecutionLog
   ├─ Format A: actions[].input  →  WriteAction[]
   └─ Format B: context.messages → toolUse[] → WriteAction[]
   │
   ▼
sessionId 检查（workspace 隔离）
   │
   ▼
计算 kiro_net_deletions（贪心 LCS 计算 AI 删除行数）
   │
   ▼
按 ignore patterns 过滤
   │
   ▼
groupActionsByRepo（多 repo 路由）
   │
   ▼
对每个 repo：
   ├─ Step 1: 发 human checkpoint（用 originalContent 作 dirty_files）
   └─ Step 2: 发 AI checkpoint（用 modifiedContent 作 dirty_files）
   │
   ▼
git-ai 写 .git/ai/working_logs/<base_sha>/checkpoints.jsonl
```

**关键决策点**：
- workspace 隔离靠 `chatSessionId` 匹配
- 每个文件归属哪个 repo 靠 `findRepoForFile`（最长前缀匹配，Windows 大小写不敏感）
- 文件存在性兜底：在 sibling repo 或 parent 目录中查找
- orphan 文件动态调用 `findGitRoot` 发现新 repo

---

## 模块 2：post-commit Hook 数据流

```
git commit 触发
   │
   ▼
.git/hooks/post-commit (sh)
   │
   ├─ 杀残留 git-ai 进程（taskkill / pkill）
   │
   ├─ 检测 amend：reflog "commit (amend)" + HEAD@{1} 取 OLD_SHA
   │
   ▼
git-ai post-commit <SHA> [--amend-from <OLD_SHA>]
   │
   ├─ 普通：handle_post_commit → post_commit::post_commit
   └─ amend：handle_post_commit → CommitAmend event
              → rewrite_authorship_after_commit_amend_with_snapshot
   │
   ▼
git-ai 读 .git/ai/working_logs/<base_sha>/
   ├─ INITIAL（前次 commit 没提交完的 AI 行）
   └─ checkpoints.jsonl（本次 AI/human checkpoint）
   │
   ▼
计算行级归属：
   ├─ committed_lines_map：本 commit 提交了的 AI 行
   ├─ uncommitted_lines_map：未提交的 AI 行（→ 新 INITIAL）
   └─ 空行 gap-filling
   │
   ▼
写 git note refs/notes/ai 到 commit
   │
   ▼
hook 继续：
   ├─ git-ai stats <SHA> --json
   ├─ git-ai diff <SHA> --json
   ├─ 计算 ai_deletions/human_deletions（用 kiro_net_deletions）
   ├─ 处理 commit_msg（写临时文件避免 Windows 编码问题）
   ├─ 拼 PAYLOAD 写入 .payload.tmp
   └─ curl -d @.payload.tmp POST /api/v1/stats
```

**关键决策点**：
- amend 必须用 `HEAD@{1}` 而非 `ORIG_HEAD`（已知问题 A1）
- 杀残留进程在两个 hook 开头都要做（已知问题 D2）
- commit_msg 全程在文件中（已知问题 B3）
- curl 选择：Windows 用 bin/curl.exe，其他平台用系统 curl（已知问题 B1）

---

## 模块 3：userSync 数据流

```
插件启动
   │
   ▼
QClientLogWatcher 监听 q-client.log
   │
   ▼
检测到 GetUsageLimitsCommand 调用
   │
   ▼
maybeDoUserSync(latestUserId)
   ├─ isFirst === true → 必上报
   └─ 否则：检查 last_upload_payload.json 中最近 [userSync] 时间戳
        ├─ < 4h → skip
        └─ ≥ 4h → 上报
   │
   ▼
doUserSync:
   ├─ kiro-cli whoami → email
   │  └─ 失败 → email = "Unknown"
   ├─ stripIdentityStorePrefix(userId)
   ├─ 拼 payload {user_name, user_ip, hostname, user_id}
   └─ POST /api/v1/userSync
```

---

## 文件位置速查

### 客户机上的文件路径

**插件安装目录**（Windows）：
```
C:\Users\<user>\.kiro\extensions\git-ai.git-ai-kiro-<version>\
├── bin/
│   ├── git-ai           # macOS arm64
│   ├── git-ai.exe       # Windows x64
│   ├── git-ai-linux     # Linux x64
│   └── curl.exe         # Windows fallback
├── out/                 # 编译后的 JS（不是源码）
│   ├── extension.js
│   ├── sessionLogWatcher.js
│   └── ...
└── package.json
```

**Kiro 用户数据目录**：
- macOS: `~/Library/Application Support/Kiro/`
- Windows: `%APPDATA%\Kiro\`
- Linux: `~/.config/Kiro/`

execution log 位置：
```
<kiro-data>/User/globalStorage/kiro.kiroagent/<some-hash>/<workspace-hash>/<execution-id>
```

q-client.log 位置：
```
<kiro-data>/logs/<date>/<window>/q-client.log
```

### 项目内文件

```
<repo>/.git/
├── hooks/
│   ├── pre-commit             # 插件安装的 hook
│   └── post-commit            # 插件安装的 hook
└── ai/
    ├── last_upload_payload.json    # 上报记录（最近 15 天）
    ├── post_commit_debug.log       # git-ai 内部 debug
    ├── kiro_net_deletions          # 临时文件，每次提交后清空
    ├── rewrite_log                 # git-ai rewrite events
    └── working_logs/<base_sha>/
        ├── INITIAL                 # 跨 commit AI 归属传递
        ├── checkpoints.jsonl       # checkpoint 原始记录
        └── blobs/<hash>            # 文件内容快照
```
