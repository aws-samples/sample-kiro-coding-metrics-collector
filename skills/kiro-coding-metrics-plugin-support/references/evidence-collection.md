# 证据文件解读手册

按文件类型说明如何**读出证据**，每种文件的关键字段、典型异常模式、对应的流水线阶段。

---

## 1. `<repo>/.git/ai/last_upload_payload.json` — 上报记录

**最重要的诊断文件**。每次 stats / userSync 上报追加一行（保留 15 天）。

### 格式

```
[stats] [2026-05-13T11:43:52Z] {"repo_name":"...","commit_sha":"...","commit_stats":{...}}
[userSync] [2026-05-13T11:30:48Z] {"user_name":"...","user_id":"..."}
```

### commit_stats 关键字段

| 字段 | 含义 | 应满足关系 |
|------|------|----------|
| `human_additions` | 人工新增行 | = `git_diff_added_lines` - `ai_additions` - `mixed_additions` |
| `ai_additions` | AI 纯新增行 | ≤ `git_diff_added_lines` |
| `mixed_additions` | AI 行后被人改 | 通常 0 或小数 |
| `ai_accepted` | AI 行原样接受 | ≤ `ai_additions` |
| `ai_deletions` | AI 删除行 | ≤ `git_diff_deleted_lines` |
| `human_deletions` | 人工删除行 | = `git_diff_deleted_lines` - `ai_deletions` |
| `git_diff_added_lines` | git diff 真值 | 真值 |
| `git_diff_deleted_lines` | git diff 真值 | 真值 |

### 异常模式速查

| 模式 | 含义 |
|------|------|
| `ai_additions=0, human_additions>0`（应有 AI） | 阶段 4/5b 归属丢失 |
| `ai_additions+human_additions < git_diff_added_lines` | 有行没归属（空行间隙） |
| `ai_deletions=0, human_deletions>0`（应有 AI 删除） | kiro_net_deletions 没写入 |
| 同一 commit_sha 多次出现 | 用户多次提交同 SHA（说明 hook 至少跑了多次） |
| 缺 [stats] 行但有 commit | post-commit hook 失败 |

### 命令

```bash
# 最近 N 条 stats
tail -c 200000 last_upload_payload.json | grep -oE '\[stats\] [^[]*' | tail -10

# ai_additions=0 占比
grep -c '"ai_additions":0' last_upload_payload.json

# 找特定 commit 的记录
grep '"commit_sha":"<sha>"' last_upload_payload.json

# 最近 userSync
grep -oE '\[userSync\] \[[^]]*\] {[^}]*}' last_upload_payload.json | tail -5
```

---

## 2. `<repo>/.git/ai/post_commit_debug.log` — git-ai 内部 debug

git-ai (Rust) 写入的 debug 日志，每个 commit 一个块。

### 格式

```
--- 1778672626 ---                       # unix timestamp
commit=0ab4d3a3...
parent=6229f3cd...
final_state=false                         # 是否用 final_state_override
va_files=["second.txt", "third.txt"]      # VirtualAttribution 加载的文件
checkpoints=["kind=Human entries=[...]", "kind=AiAgent entries=[...]"]
pathspecs={"second.txt", "third.txt"}     # 处理的文件集合
rename_map={}                             # git rename 检测
has_unresolved=false                      # 有删除文件但未匹配重命名

to_authorship_log:                        # to_authorship_log_and_initial_working_log 的内部
  attr_keys=[...]                         # VA 中的文件
  committed_hunks_keys=[...]              # git diff 中改动的文件
  pathspecs=Some({...})
  rename_map={}
```

### 关键字段含义

- `parent` 与 `git rev-parse <commit>^` 一致，amend 时 = 新 parent（不是 amend 前）
- `va_files` 应包含本次 commit 改动的所有文件
- `checkpoints` 数量 + 每个的 `la=N`（line_attributions 数量）和 `a=N`（attributions 数量） — `la=0, a=0` 是空 checkpoint
- `attr_keys` 应等于或大于 `committed_hunks_keys`（VA 包含 INITIAL 文件 + 本次 checkpoint 文件）

### 异常模式

| 模式 | 含义 |
|------|------|
| `checkpoints=[]` | 没有 checkpoint 数据，AI 编辑没记录 |
| `attr_keys=[]` 但 `committed_hunks_keys=[file]` | 文件改了但 VA 没该文件 → 归属丢失 |
| `kind=Human entries=[\"file(la=N,a=0)\"]` 中 `la` 远小于 INITIAL 范围 | 空行被排除，导致 AI 范围被拆段 |
| `parent` 与用户报的"被 amend 的 commit" 不一致 | amend 检测失效或被 amend 的不是 reflog HEAD@{1} |

---

## 3. `<repo>/.git/ai/working_logs/<base_sha>/` — 跨 commit 状态

### `INITIAL` 文件

记录跨 commit 传递的 AI 归属（commit 1 没提交完的部分）。

```json
{
  "files": {
    "test.java": [
      {
        "start_line": 21,
        "end_line": 27,
        "author_id": "abc123",
        "overrode": null
      }
    ]
  },
  "prompts": {
    "abc123": {
      "agent_id": {"tool": "kiro", "id": "...", "model": "kiro-ai"},
      "total_additions": 100,
      "total_deletions": 0,
      "accepted_lines": 50
    }
  },
  "file_blobs": {"test.java": "<content_hash>"}
}
```

**用法**：
- 当 commit 2 上报 `ai_additions=0`，看其 parent 的 `working_logs/<parent>/INITIAL`：
  - 如果 INITIAL 有 AI 范围 → 应该被 commit 2 继承（如果继承了但还是 0，看 commit 2 的 git note）
  - 如果 INITIAL 没有 → AI 范围在 commit 1 时就丢了

- `accepted_lines` 是 session 累计值（不是当前 commit）

### `checkpoints.jsonl`

每行一个 JSON，记录一次 AI/human checkpoint：

```json
{"kind": "AiAgent", "agent_id": {...}, "entries": [{"file": "...", "line_attributions": [...], "attributions": [...]}]}
{"kind": "Human", "agent_id": null, "entries": [...]}
```

**关键**：检查 Human checkpoint（pre-commit）的 `entries[].line_attributions`：
- 如果范围是连续的（如 21-27） → 正常
- 如果被拆段（21-25, 27-27 中间空一格） → 空行被错误归为 human

### `blobs/<content_hash>`

文件内容的字节快照。可以 `cat` 看实际内容，验证某个范围是不是空行。

---

## 4. DevTools Console 日志（VSCode/Kiro IDE 主进程）

获取方式：Help → Toggle Developer Tools → Console → 筛选 `[git-ai-kiro]`

### 关键日志阶段

按时间顺序看：

```
[git-ai-kiro] File changed: <hash>, size: X → Y                # 阶段 1
[git-ai-kiro] Parsed <hash>: format=A/B, actions=N             # 阶段 1
[git-ai-kiro] Skipped (sessionId mismatch / no chatSessionId)  # 阶段 1
[git-ai-kiro] Processing N write action(s) from: ...           # 阶段 2
[git-ai-kiro]   action: replace, file: X, original: ...        # 阶段 2
[git-ai-kiro] AI net deletions: N written to ...               # 阶段 2
[git-ai-kiro] Skipping file outside workspace                  # 阶段 2 异常
[git-ai-kiro] Orphan file (no matching repo)                   # 阶段 2 异常
[git-ai-kiro] Re-routed file to sibling repo                   # 阶段 2
[git-ai-kiro] Sending AI checkpoint for repo X: ...            # 阶段 3
[git-ai-kiro] Spawning: ... checkpoint agent-v1                # 阶段 3
[git-ai-kiro] git-ai stderr: ...                               # 阶段 3 异常
[git-ai-kiro] git-ai exited with code 0                        # 阶段 3
[git-ai-kiro] AI checkpoint succeeded                          # 阶段 3
```

### 卡死阶段诊断

| 卡在哪 | 推断 |
|--------|------|
| 完全没日志 | 插件没激活 |
| 停在 `Parsed ...` | execution log 解析后被 sessionId 拒了 |
| 停在 `Processing N` 后 | 路径分组报错或全 orphan |
| 停在 `Spawning ...` 后 | git-ai 启动失败（权限 / 路径） |
| `git-ai exited with code N`（N≠0） | git-ai 内部错（看 stderr） |

---

## 5. `<repo>/.git/hooks/post-commit` — Hook 文件

### 检查点

```bash
# 是否存在
ls -la .git/hooks/post-commit

# 是否包含 git-ai-kiro marker
grep "git-ai-kiro post-commit hook" .git/hooks/post-commit

# 看 git-ai 二进制路径
grep -oE '"/[^"]*/(git-ai|git-ai\.exe)"' .git/hooks/post-commit | head -1

# 看 amend 处理
grep -A 20 "IS_AMEND" .git/hooks/post-commit
```

### 不存在意味着什么

- 阶段 4 之前的设置失败
- 可能原因：
  - 插件未激活
  - repo 不在插件递归扫描范围（深度 > 5？）
  - workspace 配置异常

### 内容异常

- amend 检测块用了 `ORIG_HEAD` 而非 `HEAD@{1}` → 老版本残留（让用户重新激活插件覆盖）
- curl 命令直接 `-d "$PAYLOAD"` 而非 `-d @file` → 老版本，中文 commit_msg 会失败

---

## 6. `<repo>/.git/ai/.payload.tmp` / `.commit_msg.tmp` — 临时上报文件

正常情况下 hook 跑完会删除。如果存在说明上一次 hook 在 curl 之前失败了。

```bash
# 看 payload 字节
cat .git/ai/.payload.tmp | od -c | head

# 看 commit_msg 是否被正确转义
cat .git/ai/.commit_msg.tmp
```

字节正常但 curl 失败 → 网络问题；字节异常 → hook 处理 commit_msg 出错。

---

## 7. Kiro execution log（输入端）

位置：
- macOS: `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/<hash>/<workspace-hash>/<execution-id>`
- Windows: `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\<...>\<...>\<...>`

直接读取 JSON 内容验证：
- `actions[]` 中是否有期望的 actionType / filePath
- `actionState` 必须是 `"Accepted"`
- `chatSessionId` 是否在当前 workspace 的 `sessions.json` 中

### 找当前 workspace 的 hash

DevTools Console 中找 `Watching execution log directory: ...` 日志，最后一段就是 workspace hash。

---

## 8. q-client.log（userSync 触发源）

位置：
- macOS: `~/Library/Application Support/Kiro/logs/<date>/<window>/q-client.log`
- Windows: `%APPDATA%\Kiro\logs\<date>\<window>\q-client.log`

```bash
# 找 GetUsageLimitsCommand 调用
grep "GetUsageLimitsCommand" q-client.log | tail -5

# 提取 userId
grep -oE '"userInfo":{"userId":"[^"]+"' q-client.log | tail -1
```

---

## 证据收集优先级

实际诊断时按以下顺序拉证据：

1. **第一手**：`last_upload_payload.json`（看症状是什么）
2. **第二手**：DevTools Console（看流水线哪个阶段出错）
3. **第三手**：`post_commit_debug.log`（针对 stats 数值问题）
4. **第四手**：`working_logs/<sha>/`（针对跨 commit 归属问题）
5. **第五手**：`git notes --ref=ai show <sha>`（最终归属结果）
6. **第六手**：手动跑 hook / 手动跑 git-ai 命令（复现验证）

不要一开始就拉所有证据，按需深入。
