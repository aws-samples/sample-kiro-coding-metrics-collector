# Dashboard 后台服务说明
Dashboard 后台服务通过数据表管理用户、session、插件安装等信息，通过调用AWS SDK获取用户列表、session列表等信息，通过userSync接口供插件上传活跃信息，通过/api/users供外部查询所有的用户信息。

## 一. 用户相关数据表

Dashboard 使用 SQLite 存储用户相关数据，可切换成MySQL等DB，涉及三张表：

### kiro_user 表（用户主表）

| 字段 | 类型 | 说明 |
|---|---|---|
| user_name | TEXT (PK) | 用户 email，主键 |
| user_id | TEXT | IAM Identity Center 的 UserId，用于关联 sessions 表 |
| created_at | TEXT | 记录创建时间 (ISO 8601) |
| user_ip | TEXT | 最近一次上报的客户端公网 IP |
| credit_used | TEXT | JSON 格式的按日期 Credit 用量，如 `{"2026-04-25": 5.0}` |
| updated_at | TEXT | 最后活跃时间（插件 userSync 上报时更新） |

数据来源：
- IAM Identity Center 同步时 INSERT OR IGNORE（只插入新用户）
- 插件 userSync 上报时更新 
- S3 Credit 同步时更新 credit_used

### sessions 表（SSO 登录会话）

| 字段 | 类型 | 说明 |
|---|---|---|
| session_id | TEXT (PK) | SSO 应用会话 ID，主键 |
| user_id | TEXT | IAM Identity Center 的 UserId |
| expire_time | TEXT | 会话过期时间 (ISO 8601) |

数据来源：CloudTrail `CreateToken` 事件同步（首次 30 天，此后每日增量），过期记录自动删除。

### plugins 表（插件活跃设备）

| 字段 | 类型 | 说明 |
|---|---|---|
| hostname | TEXT (PK) | 客户端主机名（`os.hostname()`），主键 |
| user_name | TEXT | 用户 email |
| ip | TEXT | 客户端公网 IP |
| last_updated | TEXT | 最后上报时间 (ISO 8601) |

数据来源：插件 userSync 上报时 upsert（按 hostname 去重）。

### 表间关系

```
kiro_user.user_id ──── sessions.user_id     (1:N，一个用户可有多个活跃 session)
kiro_user.user_name ── plugins.user_name     (1:N，一个用户可在多台设备安装插件)
```

查询指标：
- 活跃 Session 数 = `SELECT COUNT(*) FROM sessions WHERE user_id = ?`
- 活跃插件数 = `SELECT COUNT(*) FROM plugins WHERE user_name = ?`
- 插件覆盖率 = 活跃插件数 / 活跃 Session 数（cap 到 1）
- 总插件安装率 = plugins 表总行数 / sessions 表总行数（cap 到 1）

## 环境变量

Dashboard 启动时需要配置以下环境变量：

| 变量名 | 说明 | 示例 |
|---|---|---|
| AWS_REGION | AWS 区域 | us-east-1 |
| IDENTITY_STORE_ID | IAM Identity Center 的 Identity Store ID(即Kiro登录url的前缀) | d-90xxx |
| KIRO_S3_BUCKET | Kiro User Activity Report 的 S3 桶名(credit监控用，如无credit监控需求无需配置) | my-kiro-bucket |
| KIRO_S3_PREFIX | S3 桶中的前缀路径(credit监控用，如无credit监控需求无需配置) | kiro-logs/ |
| KIRO_ACCOUNT_ID | AWS 账号 ID(credit监控用，如无credit监控需求无需配置) | 020446257700 |
| AWS_ACCESS_KEY_ID | AWS Access Key ID | AKIA... |
| AWS_SECRET_ACCESS_KEY | AWS Secret Access Key | wJal... |

运行 Dashboard 的 IAM 身份需要以下权限：
- `identitystore:ListUsers` — 查询 IAM Identity Center 用户列表
- `cloudtrail:LookupEvents` — 查询 CloudTrail 事件
- `s3:ListBucket` + `s3:GetObject` — 读取 S3 中的 Credit 用量报告(credit监控用，如无credit监控需求无需配置)

## 二、AWS SDK操作说明
本服务使用Javascript版本的sdk，如需其它编程语言，参考

### 2.1 访问 IAM Identity Center 用户列表
模块：`identityCenter.js`
SDK：`@aws-sdk/client-identitystore`

调用 `ListUsersCommand` 分页获取 Identity Store 中的所有用户，提取 userName（email）、displayName、status、userId 四个字段。

调用时机：每次访问 `/api/users` 接口时触发，将 IdC 用户同步到本地 `kiro_user` 表（INSERT OR IGNORE，不覆盖已有数据）。

返回数据示例：
```json
[
  {
    "userName": "user@example.com",
    "displayName": "张三",
    "status": "ENABLED",
    "userId": "04b8b4f8-0071-7044-fe9c-ff2bcb4fa5b3"
  }
]
```

userId 用于关联 sessions 表（CloudTrail 中的 onBehalfOf.userId）和 S3 Credit 报告中的 UserId。

### 2.2 通过AWS SDK访问 CloudTrail Session 获取用户Kiro Session信息

模块：`sessionSync.js`
SDK：`@aws-sdk/client-cloudtrail`

通过 `LookupEventsCommand` 查询 `EventName=CreateToken` 事件，从 CloudTrailEvent JSON 中提取 SSO 登录 session 信息。

调用时机：
- 首次启动：查询近 30 天的事件
- 此后每 24 小时：查询前 1 天的事件，并删除已过期的 session

CloudTrailEvent 字段提取路径：

| 目标字段 | JSON 路径 | 说明 |
|---|---|---|
| session_id | responseElements.aws_sso_app_session_id | SSO 应用会话 ID |
| user_id | userIdentity.onBehalfOf.userId | 用户 ID（关联 IdC） |
| expire_time | additionalEventData["identitycenter:SessionNotOnOrAfter"] | 会话过期时间 |

注意事项：
- `onBehalfOf` 在 `userIdentity` 下，可能是对象或数组，代码中做了兼容处理
- `authorship_note` 中 `---` 分隔符前可能有注解行，解析时用 `indexOf('---')` 而非 `startsWith('---')`

数据写入本地 SQLite `sessions` 表（session_id 为主键，upsert），每次同步后删除 `expire_time < 当前时间` 的过期记录。

CloudTrailEvent 原始数据示例（关键字段）：
```json
{
  "eventName": "CreateToken",
  "userIdentity": {
    "onBehalfOf": {
      "userId": "04b8b4f8-0071-7044-fe9c-xxx"
    }
  },
  "responseElements": {
    "aws_sso_app_session_id": "26d0b0d4-728b-4935-bdbf-xxx"
  },
  "additionalEventData": {
    "identitycenter:SessionNotOnOrAfter": "2026-07-22T08:04:36Z"
  }
}
```


### 2.3. 访问 S3 获取 Credit 用量(按需)

模块：`creditSync.js`
SDK：`@aws-sdk/client-s3`

从 Kiro 官方 S3 User Activity Report 中读取 CSV 格式的 Credit 用量数据。

调用时机：
- 启动时立即执行一次
- 此后每 1 小时执行一次

S3 路径格式：
```
s3://<bucket>/<prefix>/AWSLogs/<accountId>/KiroLogs/by_user_analytic/<region>/<year>/<month>/<day>/00/<accountId>_by_user_analytic_<timestamp>.csv
```

CSV 字段：
| 字段 | 说明 |
|---|---|
| Date | 日期（yyyy-mm-dd） |
| UserId | 用户 ID（格式：`d-xxx.userId`） |
| Client_Type | 客户端类型 |
| Subscription_Tier | 订阅层级 |
| Credits_Used | 消耗的 Credit 数量 |

处理逻辑：
1. 构建最近 30 天的 S3 前缀列表（同时覆盖新版 `by_user_analytic` 和旧版 `user_report` 路径）
2. 列出每个前缀下的 CSV 文件（`ListObjectsV2Command`）
3. 下载并解析 CSV（`GetObjectCommand`）
4. 将 UserId（`d-xxx.userId`）通过 IdC 用户映射表解析为 userName（email）
5. 调用 `userSync({ _overwrite_credits: true })` 更新本地 `kiro_user` 表的 `credit_used` 字段

UserId 解析规则：
- 如果包含 `@`，视为 email 直接使用
- 否则提取 `.` 后面的部分作为 Identity Store UserId，查 IdC 映射表得到 userName

---

## 三、Dashboard 接口文档

### POST /api/v1/userSync

插件端定时上报用户活跃信息，同时更新 `kiro_user` 表和 `plugins` 表。

请求头：
```
Content-Type: application/json
Authorization: Bearer <token>
```

请求体：
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| user_name | string | 是 | 用户 email |
| user_ip | string | 否 | 客户端公网 IP |
| hostname | string | 否 | 客户端主机名（`os.hostname()`），用于 plugins 表去重 |

请求示例：
```json
{
  "user_name": "user@example.com",
  "user_ip": "54.240.199.97",
  "hostname": "haozhas-mac.corp.amazon.com"
}
```

处理逻辑：
1. 在 `kiro_user` 表中 upsert 用户记录：更新 `user_ip`、`updated_at`
2. 如果 `hostname` 非空，在 `plugins` 表中 upsert 一条记录（hostname 为主键），更新 `user_name`、`ip`、`last_updated`

响应：
```json
{ "status": "ok" }
```

错误响应：
- 400：`{ "status": "error", "message": "Missing required field: user_name" }`
- 401：`{ "status": "error", "message": "Invalid token" }`
- 500：`{ "status": "error", "message": "<错误信息>" }`

---

### GET /api/users

查询所有用户的管理数据，包含 IAM Identity Center 用户信息、活跃 Session 数、活跃插件数、插件覆盖率、Credit 用量。

每次请求时会先从 IAM Identity Center 同步用户列表到本地表。

响应结构：
```json
{
  "users": [ ... ],
  "summary": { ... }
}
```

users 数组每个元素：
| 字段 | 类型 | 说明 |
|---|---|---|
| userName | string | 用户名（email） |
| displayName | string | IAM Identity Center 中的显示名称 |
| status | string | 用户状态（ENABLED / DISABLED / UNKNOWN） |
| activeSessions | number | 活跃 SSO Session 数（按 user_id 查 sessions 表） |
| activePlugins | number | 活跃插件设备数（按 user_name 查 plugins 表） |
| pluginCoverage | number | 插件覆盖率 (0~1)，= min(activePlugins / activeSessions, 1) |
| totalCredits | number | 近 30 天 Credit 用量（从 S3 同步） |
| creditUsed | object | 按日期的 Credit 明细，如 `{ "2026-04-20": 1.5, "2026-04-21": 2.0 }` |
| updatedAt | string | 最后活跃时间（ISO 8601），来自插件 userSync 上报 |

summary 对象：
| 字段 | 类型 | 说明 |
|---|---|---|
| totalUsers | number | 总用户数 |
| totalPlugins | number | plugins 表总行数（活跃插件设备总数） |
| totalSessions | number | sessions 表总行数（活跃 Session 总数） |
| totalPluginRate | number | 总插件安装率 (0~1)，= min(totalPlugins / totalSessions, 1) |

响应示例：
```json
{
  "users": [
    {
      "userName": "user@example.com",
      "displayName": "张三",
      "status": "ENABLED",
      "activeSessions": 3,
      "activePlugins": 1,
      "pluginCoverage": 0.333,
      "totalCredits": 12.5,
      "creditUsed": { "2026-04-25": 5.0, "2026-04-26": 7.5 },
      "updatedAt": "2026-04-26T14:21:33.842Z"
    }
  ],
  "summary": {
    "totalUsers": 50,
    "totalPlugins": 15,
    "totalSessions": 120,
    "totalPluginRate": 0.125
  }
}
```

数据来源关系：
- `userName` / `displayName` / `status` → IAM Identity Center (`identityCenter.js`)
- `activeSessions` → CloudTrail CreateToken 事件 (`sessionSync.js`) → `sessions` 表，按 `user_id` 关联
- `activePlugins` → 插件 userSync 上报 → `plugins` 表，按 `user_name` 关联
- `totalCredits` / `creditUsed` → S3 User Activity Report (`creditSync.js`) → `kiro_user` 表
- `updatedAt` → 插件 userSync 上报 → `kiro_user.updated_at`
