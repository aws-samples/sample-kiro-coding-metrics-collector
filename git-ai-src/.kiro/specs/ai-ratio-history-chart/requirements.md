# Requirements Document

## Introduction

本功能为 kiro-dashboard 新增 AI 代码占比历史趋势追踪能力。每次 ingest 接收到新的 commit 统计数据时，系统自动计算并快照该仓库当前的 AI 代码占比，存入 SQLite 新表。前端仓库详情 modal 中新增一条历史曲线图，展示 AI 占比随时间的变化趋势。

## Glossary

- **Ingest_Server**: 运行在端口 80 的统计数据接收服务，处理 POST /api/v1/stats 请求
- **Dashboard_Server**: 运行在端口 3500 的仪表盘服务，提供查询 API 和静态文件
- **Store**: 数据访问层模块（store.js），封装所有 SQLite 读写操作
- **AI_Ratio**: AI 代码占比，计算公式为 `ai_additions / (human_additions + ai_additions + mixed_additions)`，结果为 0 到 1 之间的浮点数
- **AI_Ratio_History**: SQLite 中存储 AI 占比历史快照的表
- **History_Chart**: 前端仓库详情 modal 中展示 AI 占比历史趋势的折线图
- **Commit_Payload**: ingest 接收到的 JSON 数据，包含 repo_name、commit_sha、commit_stats 等字段

## Requirements

### Requirement 1: AI 占比历史快照表

**User Story:** 作为系统管理员，我希望有一个专用的数据库表来存储每次提交后的 AI 代码占比快照，以便后续查询历史趋势。

#### Acceptance Criteria

1. WHEN the Store module initializes, THE Store SHALL create an `ai_ratio_history` table with columns: `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `repo_name` (TEXT NOT NULL), `recorded_at` (TEXT NOT NULL), `ai_ratio` (REAL NOT NULL), `ai_additions` (INTEGER NOT NULL), `human_additions` (INTEGER NOT NULL), `mixed_additions` (INTEGER NOT NULL), `commit_sha` (TEXT NOT NULL)
2. WHEN the Store module initializes, THE Store SHALL create an index on `ai_ratio_history(repo_name, recorded_at)` for efficient time-range queries
3. THE Store SHALL preserve all existing tables and data when creating the new `ai_ratio_history` table

### Requirement 2: Ingest 时自动记录 AI 占比快照

**User Story:** 作为系统管理员，我希望每次接收到新的 commit 统计数据时，系统自动计算并保存该仓库的累计 AI 代码占比，以便追踪历史趋势。

#### Acceptance Criteria

1. WHEN the Ingest_Server successfully saves a Commit_Payload, THE Store SHALL calculate the current cumulative AI_Ratio for the corresponding repository by summing all `ai_additions`, `human_additions`, and `mixed_additions` from the `commits` table
2. WHEN the cumulative total of `human_additions + ai_additions + mixed_additions` for a repository is greater than zero, THE Store SHALL insert a new row into `ai_ratio_history` with the calculated AI_Ratio, the individual addition counts, the current timestamp, and the commit_sha from the payload
3. IF the cumulative total of `human_additions + ai_additions + mixed_additions` for a repository equals zero, THEN THE Store SHALL skip inserting an AI_Ratio snapshot for that repository
4. THE Store SHALL execute the commit save and the AI_Ratio snapshot insert within the same database transaction to ensure data consistency

### Requirement 3: AI 占比历史查询 API

**User Story:** 作为前端开发者，我希望有一个 API 端点来查询某个仓库的 AI 占比历史数据，以便在前端绘制趋势图。

#### Acceptance Criteria

1. WHEN a GET request is received at `/api/repos/:name/ai-ratio-history`, THE Dashboard_Server SHALL return a JSON array of AI_Ratio_History records for the specified repository, sorted by `recorded_at` in ascending order
2. THE Dashboard_Server SHALL return each record containing `recorded_at`, `ai_ratio`, `ai_additions`, `human_additions`, `mixed_additions`, and `commit_sha` fields
3. IF the specified repository has no AI_Ratio_History records, THEN THE Dashboard_Server SHALL return an empty JSON array with HTTP status 200
4. IF the specified repository does not exist, THEN THE Dashboard_Server SHALL return an empty JSON array with HTTP status 200

### Requirement 4: 前端 AI 占比历史曲线图

**User Story:** 作为仪表盘用户，我希望在点击仓库卡片后的详情弹窗中看到 AI 代码占比的历史趋势曲线，以便直观了解 AI 使用率的变化。

#### Acceptance Criteria

1. WHEN the user opens a repository detail modal, THE History_Chart SHALL fetch data from `/api/repos/:name/ai-ratio-history` and render a line chart showing AI_Ratio over time
2. THE History_Chart SHALL display the X axis as time (formatted as date) and the Y axis as AI 占比 percentage (0% to 100%)
3. THE History_Chart SHALL use Chart.js library (loaded via CDN) to render the line chart, reducing custom drawing code and potential bugs
4. WHEN the AI_Ratio_History data contains fewer than 2 data points, THE History_Chart SHALL display a text message "数据不足，暂无趋势图" instead of the chart
5. THE History_Chart SHALL be placed between the "汇总统计" section and the "按开发者" section in the modal layout
6. WHEN the user hovers over a data point on the History_Chart, THE History_Chart SHALL display a tooltip showing the date and the AI_Ratio percentage value

### Requirement 5: 历史数据回填

**User Story:** 作为系统管理员，我希望对已有的 commit 数据进行回填，为每个仓库生成初始的 AI 占比历史记录，以便在功能上线后立即看到历史趋势。

#### Acceptance Criteria

1. WHEN the Store module initializes and the `ai_ratio_history` table is empty, THE Store SHALL backfill AI_Ratio snapshots by replaying all existing commits in `reported_at` ascending order
2. THE Store SHALL calculate a running cumulative AI_Ratio for each repository during backfill, inserting one snapshot per commit to reflect the progressive change in AI_Ratio
3. THE Store SHALL execute the backfill operation only once, skipping it when the `ai_ratio_history` table already contains data
