# Stats Upload API 接口定义

## 概述

Kiro 插件在每次 `git commit` 后，调用 `git-ai stats <commit_sha> --json` 获取该 commit 的归属统计数据，通过 HTTPS POST 上传到控制面板服务。

采用增量上报模式：每次 commit 只上报该 commit 产生的数据（包括人工和 AI 的代码行数），服务端负责按用户、仓库维度汇总。这样在多人协作的仓库中，每个开发者独立上报自己的增量，服务端可以正确聚合所有人的统计。

## 接口

### POST /api/v1/stats

#### Request Headers

```
Content-Type: application/json
Authorization: Bearer <token>
X-Idempotency-Key: <unique-key>
```

服务端收到请求后，先检查该 key 是否已处理过：
- 若已存在：直接返回上次的响应结果（HTTP 200），不重复写入
- 若不存在：正常处理并存储该 key，建议保留 24 小时后过期

#### Request Body

```jsonc
{
  "repo_name": "git-ai",
  "repo_remote_url": "git@github.com:user/repo.git",
  "branch": "main",
  "commit_sha": "6e7f6f94a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  "commit_msg": "Add new feature X",
  "machine_id": "a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1",
  "user_name": "fqchen",
  "user_email": "fqchen@example.com",
  "reported_at": "2026-04-08T12:00:00Z",
  "commit_stats": {
    "human_additions": 25,
    "ai_additions": 45,
    "mixed_additions": 2,
    "ai_accepted": 43,
    "total_ai_additions": 52,
    "total_ai_deletions": 8,
    "time_waiting_for_ai": 15,
    "git_diff_added_lines": 72,
    "git_diff_deleted_lines": 10,
    "tool_model_breakdown": {
      "kiro/claude-sonnet-4": {
        "ai_additions": 45,
        "mixed_additions": 2,
        "ai_accepted": 43,
        "total_ai_additions": 52,
        "total_ai_deletions": 8,
        "time_waiting_for_ai": 15
      }
    }
  }
}
```

---

## 字段说明

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `repo_name` | string | 是 | 仓库名称，取自目录名或 git remote 的仓库名部分 |
| `repo_remote_url` | string | 否 | `git remote get-url origin` 的值，本地仓库无 remote 时为空字符串 |
| `branch` | string | 是 | 当前分支名，如 `main`、`feature/xxx` |
| `commit_sha` | string | 是 | 本次 commit 的完整 SHA（40 字符） |
| `commit_msg` | string | 否 | 本次 commit 的 subject（首行），由 `git log -1 --pretty=%s` 获取；便于在 dashboard 上识别提交用途 |
| `machine_id` | string | 是 | 机器标识，由 hostname 的 SHA-256 哈希生成，用于区分不同开发机器 |
| `user_name` | string | 否 | `git config user.name` 的值，未配置时为空字符串 |
| `user_email` | string | 否 | `git config user.email` 的值，未配置时为空字符串 |
| `reported_at` | string | 是 | 上报时间，ISO 8601 格式，UTC 时区，如 `2026-04-08T12:00:00Z` |

---

### commit_stats（本次 commit 的统计）

由 `git-ai stats <commit_sha> --json` 输出，包含该 commit 的完整归属统计。所有行数均指 git diff 中的"新增行"（additions）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `human_additions` | number | 人类编写的代码行数。这些行在提交时没有任何 AI 归属标记 |
| `ai_additions` | number | AI 生成并提交的代码行数（含 mixed）。即 `ai_accepted + mixed_additions` |
| `mixed_additions` | number | AI 生成后被人类修改的行数 |
| `ai_accepted` | number | AI 生成且被人类原样接受的行数 |
| `total_ai_additions` | number | AI 在工作过程中生成的总行数（包括后来被删除或覆盖的行） |
| `total_ai_deletions` | number | AI 在工作过程中删除的总行数 |
| `time_waiting_for_ai` | number | 等待 AI 响应的累计时间，单位为秒 |
| `git_diff_added_lines` | number | git diff 统计的总新增行数 |
| `git_diff_deleted_lines` | number | git diff 统计的总删除行数 |
| `tool_model_breakdown` | object | 按 AI 工具和模型维度的细分统计。key 格式为 `{agent_name}/{model_name}` |

#### tool_model_breakdown（工具模型细分）

每个 key 是 `{agent_name}/{model_name}` 格式的字符串，value 包含该工具+模型组合的统计数据。

| 字段 | 类型 | 说明 |
|------|------|------|
| `ai_additions` | number | 该工具+模型生成并提交的代码行数（含 mixed） |
| `mixed_additions` | number | 该工具+模型生成后被人类修改的行数 |
| `ai_accepted` | number | 该工具+模型生成且被原样接受的行数 |
| `total_ai_additions` | number | 该工具+模型在工作过程中生成的总行数 |
| `total_ai_deletions` | number | 该工具+模型在工作过程中删除的总行数 |
| `time_waiting_for_ai` | number | 等待该工具+模型响应的累计时间（秒） |

---

### 服务端汇总逻辑

服务端收到增量数据后，按以下维度汇总：

- 按 `repo_remote_url`（或 `repo_name`）聚合同一仓库的数据
- 按 `user_email`（或 `user_name`）区分不同开发者
- 按 `tool_model_breakdown` 中的 key 区分不同 AI 工具和模型
- 按时间窗口（日/周/月）聚合趋势数据
- 通过 `commit_sha` + `machine_id` 去重，避免同一次 commit 被重复计入

#### 常用汇总指标

| 指标 | 计算方式 | 说明 |
|------|----------|------|
| 某用户的 AI 代码总量 | `SUM(ai_additions)` WHERE `user_email = X` | 该用户所有 commit 的 AI 代码行数累加 |
| 某用户的人工代码总量 | `SUM(human_additions)` WHERE `user_email = X` | 该用户所有 commit 的人工代码行数累加 |
| 仓库 AI 代码占比 | `SUM(ai_additions) / SUM(git_diff_added_lines) * 100` | 所有 commit 汇总后计算 |
| AI 代码接受率 | `SUM(ai_accepted) / SUM(total_ai_additions) * 100` | 汇总后计算比率 |
| 按工具模型细分 | `GROUP BY tool_model` | 对比不同 AI 工具的贡献 |

---

## Response

成功：
```json
{ "status": "ok" }
```
HTTP 200

失败：
```json
{ "status": "error", "message": "Invalid token" }
```
HTTP 401 / 400 / 500

---

## 插件配置项

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `gitai.kiro.statsUploadUrl` | string | `""` | 统计数据上传地址（完整 URL），为空则不上传 |
| `gitai.kiro.statsUploadToken` | string | `""` | Bearer token 用于鉴权 |

---

## 触发时机

- 每次 `git commit` 完成后（通过 VS Code git 扩展 API 监听 HEAD 变化，检测到新 commit 时触发上报）

## 注意事项

- `statsUploadUrl` 或 `statsUploadToken` 为空时功能完全关闭，不发送任何请求
- 上传失败只记录到 Output Channel 日志，不弹窗打扰用户
- HTTP 请求超时 10 秒
- 异步执行，不阻塞 commit 流程
- 网络失败时自动重试，最多 3 次，间隔 2s / 4s / 8s（指数退避）
- 每次重试携带相同的 `X-Idempotency-Key`，服务端据此去重，确保同一次上报不会重复写入
- 仅对网络错误和 HTTP 5xx 重试，4xx 错误不重试
