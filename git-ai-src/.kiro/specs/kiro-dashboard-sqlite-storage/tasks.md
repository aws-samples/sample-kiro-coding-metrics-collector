# 实施计划：kiro-dashboard SQLite 存储

## 概述

将 `kiro-dashboard` 的 `store.js` 从文件系统存储迁移到 SQLite。分为四个阶段：依赖安装与数据库初始化、存储函数迁移、查询函数迁移、验证与清理。

## 任务

- [x] 1. 安装依赖并初始化数据库
  - [x] 1.1 在 `agent-support/kiro-dashboard/` 下安装 `better-sqlite3`
    - 运行 `npm install better-sqlite3`
    - 确认 `package.json` 中已添加依赖
    - _需求: 1.4_

  - [x] 1.2 重写 `src/store.js` 的模块初始化部分
    - 替换文件系统相关的 `require` 和常量（`DATA_DIR`、`IDEMPOTENCY_DIR`、`fs.mkdirSync`）
    - 引入 `better-sqlite3`，创建数据库连接，指向 `data/stats.db`
    - 设置 `PRAGMA journal_mode = WAL` 和 `PRAGMA foreign_keys = ON`
    - 执行 `CREATE TABLE IF NOT EXISTS` 创建 `commits`、`tool_model_stats`、`idempotency_keys` 三张表
    - 创建索引：`idx_commits_repo_name`、`idx_commits_user_email`、`idx_commits_reported_at`、`idx_tool_model_stats_commit_id`
    - 保留 `DATA_DIR` 常量和 `fs.mkdirSync(DATA_DIR)` 用于确保 `data/` 目录存在
    - _需求: 1.1, 1.2, 1.3, 4.1, 4.2, 4.3, 4.4_

- [x] 2. 迁移写入函数
  - [x] 2.1 重写 `saveStats(payload)`
    - 使用 `db.transaction()` 包装写入操作
    - 将 payload 顶层字段和 `commit_stats` 字段 INSERT 到 `commits` 表
    - 遍历 `commit_stats.tool_model_breakdown`，将每个条目 INSERT 到 `tool_model_stats` 表，关联 `commits.id`
    - 保持函数签名 `saveStats(payload)` 不变
    - _需求: 2.2, 4.1, 4.3_

  - [x] 2.2 重写 `hasIdempotencyKey(key)` 和 `setIdempotencyKey(key)`
    - `hasIdempotencyKey`: `SELECT 1 FROM idempotency_keys WHERE key = ?`，返回布尔值
    - `setIdempotencyKey`: `INSERT OR IGNORE INTO idempotency_keys (key, created_at) VALUES (?, ?)`
    - 保持函数签名不变
    - _需求: 2.3, 2.4_

- [x] 3. 迁移查询函数
  - [x] 3.1 重写 `listRepos()`
    - `SELECT DISTINCT repo_name FROM commits ORDER BY repo_name`
    - 返回字符串数组，与原实现格式一致
    - _需求: 3.1_

  - [x] 3.2 重写 `getRepoStats(repoName)`
    - 从 `commits` 表查询指定 repo 的所有记录，按 `reported_at DESC` 排序
    - 对每条记录，从 `tool_model_stats` 表查询关联的 tool_model 数据，组装为 `tool_model_breakdown` 对象
    - 返回的每条记录格式与原始 Stats_Payload JSON 一致（包含 `repo_name`、`commit_stats` 嵌套结构等）
    - _需求: 3.2_

  - [x] 3.3 重写 `aggregateRepoStats(repoName)`
    - 使用 SQL `SUM()` 聚合 `commits` 表的数值字段得到 `totals`
    - 按 `user_email`（或 `user_name`）分组聚合得到 `by_user`
    - 从 `tool_model_stats` 表按 `tool_model` 分组聚合得到 `by_tool_model`
    - 获取最新一条记录的 `branch`、`commit_sha`、`reported_at` 作为顶层字段
    - 返回格式与原实现完全一致
    - _需求: 3.3_

  - [x] 3.4 重写 `getAllReposSummary()`
    - 对每个 repo 调用 `aggregateRepoStats` 并组装摘要
    - 返回格式与原实现一致
    - _需求: 3.4_

- [x] 4. 检查点 - 验证功能正确性
  - 启动服务 `node src/main.js`，通过 curl 发送测试请求到 `/api/v1/stats`
  - 验证 `/api/repos` 和 `/api/repos/:name` 返回正确数据
  - 验证幂等性：相同 key 的重复请求返回 200 且不产生重复数据
  - 检查 `data/stats.db` 文件已创建
  - 如有问题请询问用户

- [x] 5. 错误处理与健壮性
  - [x] 5.1 为查询函数添加 try-catch
    - `listRepos`、`getRepoStats`、`aggregateRepoStats`、`getAllReposSummary` 查询失败时记录日志并返回空结果
    - `hasIdempotencyKey` 查询失败时返回 `false`
    - `saveStats` 写入失败时让异常向上抛出（ingest.js 已有 catch 处理）
    - _需求: 6.1, 6.2_

  - [x] 5.2 移除旧的文件系统存储代码
    - 移除 `sanitizeName` 函数
    - 移除 `IDEMPOTENCY_DIR` 常量
    - 移除所有 `fs.existsSync`、`fs.writeFileSync`、`fs.readdirSync`、`fs.readFileSync` 调用
    - 移除 `require("node:fs")` 导入（如果不再需要，保留 `mkdirSync` 则保留 fs）
    - _需求: 1.1_

- [x] 6. 数据迁移脚本（可选）
  - [x] 6.1 新增 `src/migrate.js` 脚本
    - 读取 `data/` 目录下现有的 JSON 文件
    - 解析每个文件并调用 `saveStats` 写入 SQLite
    - 使用 `commit_sha` 去重，避免重复导入
    - 可通过 `node src/migrate.js` 手动执行
    - _需求: 5.1, 5.2, 5.3_

- [x] 7. 最终检查点
  - 确认 `npm start` 能正常启动服务
  - 确认所有 API 端点返回正确数据
  - 如有问题请询问用户

## 备注

- 任务 6 为可选任务，可跳过以加速交付
- `better-sqlite3` 是原生模块，需要 Node.js 编译工具链（macOS 上通常已有 Xcode Command Line Tools）
- 所有函数签名和返回值格式保持不变，调用方（ingest.js、dashboard.js）无需修改
- `store.js` 的 `module.exports` 保持不变
