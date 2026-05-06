# 设计文档：kiro-dashboard SQLite 存储

## 概述

将 `kiro-dashboard` 的 `store.js` 模块从文件系统存储迁移到 SQLite，使用 `better-sqlite3` 包进行同步数据库操作。所有对外接口（函数签名和返回值格式）保持不变，仅内部实现从文件 I/O 切换为 SQL 操作。

### 设计决策

**为什么选择 `better-sqlite3` 而非 `sqlite3`（异步版本）？**

当前 `store.js` 的所有函数都是同步的（`saveStats`、`hasIdempotencyKey` 等），调用方（`ingest.js`、`dashboard.js`）也按同步方式使用。`better-sqlite3` 提供同步 API，可以无缝替换，无需将调用链改为 async/await。且 `better-sqlite3` 性能更优，是 Node.js SQLite 的事实标准。

**为什么将 `tool_model_breakdown` 拆分为独立表？**

`tool_model_breakdown` 是一个动态 key-value 结构（key 为 `agent/model` 字符串），存为 JSON 列虽然简单但无法高效查询。拆分为 `tool_model_stats` 表后，可以直接用 SQL 按工具模型维度聚合，支持 `aggregateRepoStats` 中的 `by_tool_model` 计算。

**为什么使用 WAL 模式？**

Ingest_Server 和 Dashboard_Server 在同一进程中运行（通过 `main.js` 启动），但写入和读取可能并发。WAL 模式允许读写并发，避免锁等待。

## 架构

### 模块依赖关系

```
main.js
├── ingest.js  ──→ store.js ──→ SQLite (data/stats.db)
├── dashboard.js ──→ store.js ──→ SQLite (data/stats.db)
└── auth.js
```

`store.js` 是唯一与数据库交互的模块，对外接口不变。

### 数据流

```
POST /api/v1/stats
  → ingest.js: 解析 body
  → store.js: hasIdempotencyKey(key) → SELECT from idempotency_keys
  → store.js: saveStats(payload) → INSERT into commits + tool_model_stats (事务)
  → store.js: setIdempotencyKey(key) → INSERT into idempotency_keys

GET /api/repos
  → dashboard.js
  → store.js: getAllReposSummary() → SELECT + 聚合

GET /api/repos/:name
  → dashboard.js
  → store.js: getRepoStats(name) → SELECT from commits + tool_model_stats

GET /api/repos/:name/aggregate
  → dashboard.js
  → store.js: aggregateRepoStats(name) → SELECT + SQL 聚合
```

## 组件与接口

### 1. 数据库初始化

**文件**: `src/store.js`

在模块加载时初始化数据库连接和表结构：

```javascript
const Database = require("better-sqlite3");
const path = require("node:path");

const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "stats.db");

// 确保 data 目录存在
const fs = require("node:fs");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// 建表
db.exec(`
  CREATE TABLE IF NOT EXISTS commits ( ... );
  CREATE TABLE IF NOT EXISTS tool_model_stats ( ... );
  CREATE TABLE IF NOT EXISTS idempotency_keys ( ... );
  CREATE INDEX IF NOT EXISTS ...;
`);
```

### 2. saveStats(payload)

使用事务将 payload 写入 `commits` 表和 `tool_model_stats` 表：

```javascript
function saveStats(payload) {
  const insertCommit = db.prepare(`INSERT INTO commits (...) VALUES (...)`);
  const insertToolModel = db.prepare(`INSERT INTO tool_model_stats (...) VALUES (...)`);

  const transaction = db.transaction((payload) => {
    const cs = payload.commit_stats || {};
    const info = insertCommit.run(
      payload.repo_name, payload.repo_remote_url, payload.branch,
      payload.commit_sha, payload.machine_id,
      payload.user_name, payload.user_email, payload.reported_at,
      cs.human_additions, cs.ai_additions, cs.mixed_additions,
      cs.ai_accepted, cs.total_ai_additions, cs.total_ai_deletions,
      cs.time_waiting_for_ai, cs.git_diff_added_lines, cs.git_diff_deleted_lines
    );
    const commitId = info.lastInsertRowid;

    const tmb = cs.tool_model_breakdown || {};
    for (const [toolModel, stats] of Object.entries(tmb)) {
      insertToolModel.run(
        commitId, toolModel,
        stats.ai_additions, stats.mixed_additions, stats.ai_accepted,
        stats.total_ai_additions, stats.total_ai_deletions,
        stats.time_waiting_for_ai
      );
    }
  });

  transaction(payload);
}
```

### 3. 幂等性检查

```javascript
function hasIdempotencyKey(key) {
  const row = db.prepare("SELECT 1 FROM idempotency_keys WHERE key = ?").get(key);
  return !!row;
}

function setIdempotencyKey(key) {
  db.prepare("INSERT OR IGNORE INTO idempotency_keys (key, created_at) VALUES (?, ?)")
    .run(key, new Date().toISOString());
}
```

### 4. 查询函数

**listRepos()**: 
```sql
SELECT DISTINCT repo_name FROM commits ORDER BY repo_name
```

**getRepoStats(repoName)**:
查询 `commits` 表获取记录，再为每条记录查询 `tool_model_stats` 组装 `tool_model_breakdown`，按 `reported_at DESC` 排序。返回与原始 JSON 文件格式一致的对象数组。

**aggregateRepoStats(repoName)**:
可以用 SQL 聚合 `commits` 表的数值字段（SUM），再分别按 `user_email` 和 `tool_model` 维度聚合。返回格式与当前实现一致。

**getAllReposSummary()**:
对每个 repo 调用 `aggregateRepoStats` 并组装摘要，或用单条 SQL 完成。

## 数据模型

### commits 表

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 自增主键 |
| repo_name | TEXT | NOT NULL | 仓库名称 |
| repo_remote_url | TEXT | | 远程仓库 URL |
| branch | TEXT | | 分支名 |
| commit_sha | TEXT | NOT NULL | commit SHA |
| machine_id | TEXT | | 机器标识 |
| user_name | TEXT | | 用户名 |
| user_email | TEXT | | 用户邮箱 |
| reported_at | TEXT | | ISO 8601 时间戳 |
| human_additions | INTEGER | DEFAULT 0 | 人工代码行数 |
| ai_additions | INTEGER | DEFAULT 0 | AI 代码行数 |
| mixed_additions | INTEGER | DEFAULT 0 | 混合编辑行数 |
| ai_accepted | INTEGER | DEFAULT 0 | AI 原样接受行数 |
| total_ai_additions | INTEGER | DEFAULT 0 | AI 总新增行数 |
| total_ai_deletions | INTEGER | DEFAULT 0 | AI 总删除行数 |
| time_waiting_for_ai | INTEGER | DEFAULT 0 | 等待 AI 时间（秒） |
| git_diff_added_lines | INTEGER | DEFAULT 0 | diff 新增行数 |
| git_diff_deleted_lines | INTEGER | DEFAULT 0 | diff 删除行数 |
| created_at | TEXT | DEFAULT CURRENT_TIMESTAMP | 记录创建时间 |

### tool_model_stats 表

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 自增主键 |
| commit_id | INTEGER | NOT NULL, REFERENCES commits(id) | 关联 commit |
| tool_model | TEXT | NOT NULL | 工具+模型名称，如 `kiro/claude-sonnet-4` |
| ai_additions | INTEGER | DEFAULT 0 | |
| mixed_additions | INTEGER | DEFAULT 0 | |
| ai_accepted | INTEGER | DEFAULT 0 | |
| total_ai_additions | INTEGER | DEFAULT 0 | |
| total_ai_deletions | INTEGER | DEFAULT 0 | |
| time_waiting_for_ai | INTEGER | DEFAULT 0 | |

### idempotency_keys 表

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| key | TEXT | PRIMARY KEY | 幂等性 key |
| created_at | TEXT | NOT NULL | 创建时间 |

### 索引

```sql
CREATE INDEX IF NOT EXISTS idx_commits_repo_name ON commits(repo_name);
CREATE INDEX IF NOT EXISTS idx_commits_user_email ON commits(user_email);
CREATE INDEX IF NOT EXISTS idx_commits_reported_at ON commits(reported_at);
CREATE INDEX IF NOT EXISTS idx_tool_model_stats_commit_id ON tool_model_stats(commit_id);
```

## 正确性属性

### 属性 1：存储与查询一致性

*对于任意*有效的 Stats_Payload，通过 `saveStats(payload)` 存储后，`getRepoStats(payload.repo_name)` 返回的记录中应包含一条与原始 payload 数据一致的记录（所有字段值匹配）。

**验证: 需求 2.2, 3.2**

### 属性 2：幂等性保证

*对于任意*幂等性 key，调用 `setIdempotencyKey(key)` 后，`hasIdempotencyKey(key)` 应返回 `true`；未调用 `setIdempotencyKey` 的 key，`hasIdempotencyKey` 应返回 `false`。

**验证: 需求 2.3, 2.4**

### 属性 3：聚合计算正确性

*对于任意*仓库的多条 commit 记录，`aggregateRepoStats(repoName)` 返回的 `totals` 中各数值字段应等于该仓库所有 commit 记录对应字段的 SUM。

**验证: 需求 3.3**

### 属性 4：事务原子性

*对于任意* Stats_Payload，`saveStats` 要么同时成功写入 `commits` 和 `tool_model_stats` 两张表，要么两张表都不写入（事务回滚）。

**验证: 需求 6.1**

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 数据库文件不存在 | `better-sqlite3` 自动创建 |
| `saveStats` 写入失败（磁盘满等） | 事务回滚，抛出异常，ingest.js 返回 HTTP 500 |
| `getRepoStats` 查询失败 | 捕获异常，记录日志，返回空数组 `[]` |
| `aggregateRepoStats` 查询失败 | 捕获异常，记录日志，返回 `null` |
| `hasIdempotencyKey` 查询失败 | 捕获异常，记录日志，返回 `false`（允许重复处理，优于拒绝服务） |
| 数据库锁冲突 | WAL 模式下极少发生；`better-sqlite3` 同步 API 会自动等待 |

## 测试策略

### 单元测试

- `saveStats` + `getRepoStats` 往返测试：写入后读取，验证数据一致
- `hasIdempotencyKey` / `setIdempotencyKey` 往返测试
- `aggregateRepoStats` 聚合正确性：写入多条记录，验证 SUM 计算
- `listRepos` 去重和排序
- `getAllReposSummary` 格式正确性
- `tool_model_breakdown` 的存储和还原

### 集成测试

- 通过 HTTP 请求 POST `/api/v1/stats`，再 GET `/api/repos` 验证端到端流程
- 幂等性：相同 key 的重复请求不产生重复数据
- 并发写入：多个请求同时写入不报错
