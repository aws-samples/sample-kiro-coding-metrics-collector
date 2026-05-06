# 需求文档

## 简介

当前 `kiro-dashboard` 使用文件系统存储接收到的 stats 数据：每条 commit 记录保存为独立的 JSON 文件，按 `repo_name/user_email/` 目录结构组织；幂等性 key 也以空文件形式存储在 `.idempotency/` 目录下。

这种方式在数据量增长后存在性能瓶颈（目录遍历慢、聚合查询需要逐文件读取解析），且缺乏事务保证和灵活的查询能力。

本功能的目标是：将 `kiro-dashboard` 的数据存储从文件系统迁移到本地 SQLite 数据库，保持所有现有 API 接口和行为不变，同时获得更好的查询性能和数据管理能力。

## 术语表

- **Ingest_Server**: `src/ingest.js` 中的 HTTP 服务，监听 `/api/v1/stats` 接口接收 commit 统计数据
- **Dashboard_Server**: `src/dashboard.js` 中的 HTTP 服务，提供 `/api/repos` 等查询接口和静态文件服务
- **Store**: `src/store.js` 模块，封装所有数据存储和查询逻辑，被 Ingest_Server 和 Dashboard_Server 共同依赖
- **Stats_Payload**: POST `/api/v1/stats` 接口接收的 JSON 请求体，包含 commit 级别的归属统计数据
- **Idempotency_Key**: 请求头 `X-Idempotency-Key` 的值，用于防止同一请求被重复处理
- **Tool_Model_Breakdown**: Stats_Payload 中 `commit_stats.tool_model_breakdown` 字段，按 AI 工具+模型维度的细分统计

## 需求

### 需求 1：使用 SQLite 替代文件系统存储

**用户故事：** 作为 dashboard 运维人员，我希望数据存储在 SQLite 数据库中，以获得更好的查询性能和数据一致性。

#### 验收标准

1. THE Store SHALL use a local SQLite database file to persist all stats data, replacing the current file-system-based storage
2. THE SQLite database file SHALL be located at `data/stats.db` relative to the kiro-dashboard project root
3. THE Store SHALL create the database file and required tables automatically on first initialization if they do not exist
4. THE Store SHALL use the `better-sqlite3` npm package for synchronous SQLite access

### 需求 2：保持 Ingest API 行为不变

**用户故事：** 作为 kiro 插件开发者，我希望 `/api/v1/stats` 接口的行为完全不变，这样插件端无需任何修改。

#### 验收标准

1. THE Ingest_Server SHALL accept the same Stats_Payload JSON format as before
2. THE Store `saveStats(payload)` function SHALL insert the payload data into SQLite instead of writing JSON files
3. THE Store `hasIdempotencyKey(key)` function SHALL query SQLite instead of checking file existence
4. THE Store `setIdempotencyKey(key)` function SHALL insert into SQLite instead of creating empty files
5. THE Ingest_Server response format and HTTP status codes SHALL remain unchanged

### 需求 3：保持 Dashboard 查询 API 行为不变

**用户故事：** 作为 dashboard 用户，我希望查询接口返回的数据格式和内容与之前一致。

#### 验收标准

1. THE Store `listRepos()` function SHALL return the same array of repo name strings by querying SQLite
2. THE Store `getRepoStats(repoName)` function SHALL return the same array of commit records (sorted by `reported_at` descending) by querying SQLite
3. THE Store `aggregateRepoStats(repoName)` function SHALL return the same aggregated summary object, with totals, by_user, and by_tool_model breakdowns computed via SQL queries or in-memory aggregation from SQLite data
4. THE Store `getAllReposSummary()` function SHALL return the same summary array by querying SQLite

### 需求 4：数据库表结构设计

**用户故事：** 作为开发者，我希望数据库表结构能高效支持现有的查询模式。

#### 验收标准

1. THE Store SHALL create a `commits` table to store commit-level stats records, with columns covering all top-level fields and `commit_stats` fields from the Stats_Payload
2. THE Store SHALL create an `idempotency_keys` table with at minimum a `key` column (TEXT, PRIMARY KEY) and a `created_at` column (TEXT)
3. THE Store SHALL create a `tool_model_stats` table to store per-commit tool_model_breakdown entries, with a foreign key referencing the `commits` table
4. THE Store SHALL create appropriate indexes on `commits.repo_name`, `commits.user_email`, and `commits.reported_at` for efficient querying

### 需求 5：数据迁移（可选）

**用户故事：** 作为 dashboard 运维人员，我希望能将现有文件系统中的历史数据迁移到 SQLite 中。

#### 验收标准

1. THE Store MAY provide a `migrateFromFiles()` function that reads existing JSON files from the `data/` directory and inserts them into SQLite
2. IF migration is provided, THEN it SHALL be idempotent — running it multiple times SHALL NOT create duplicate records
3. IF migration is provided, THEN it SHALL be triggered manually (e.g., via a CLI command or environment variable), not automatically on startup

### 需求 6：错误处理与健壮性

**用户故事：** 作为 dashboard 运维人员，我希望数据库操作的错误能被妥善处理，不会导致服务崩溃。

#### 验收标准

1. IF a SQLite write operation fails, THEN THE Store SHALL log the error and throw an exception (allowing the Ingest_Server to return HTTP 500)
2. IF a SQLite read operation fails, THEN THE Store SHALL log the error and return an empty result (empty array or null)
3. THE Store SHALL use SQLite WAL mode for better concurrent read/write performance
