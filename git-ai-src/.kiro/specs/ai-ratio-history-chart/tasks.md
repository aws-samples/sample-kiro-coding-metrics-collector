# Implementation Plan: AI Ratio History Chart

## Overview

为 kiro-dashboard 新增 AI 代码占比历史趋势追踪功能。实现分为五个阶段：数据库表创建与回填、Store 层快照记录与查询函数、Dashboard API 路由、前端 Chart.js 图表渲染、测试与验证。前端图表使用 Chart.js（通过 CDN 引入），减少手写绘图代码和潜在 bug。实现语言为 JavaScript (Node.js CommonJS)，测试使用 vitest + fast-check。

## Tasks

- [x] 1. 数据库表创建与测试框架搭建
  - [x] 1.1 在 `agent-support/kiro-dashboard/src/store.js` 的 `db.exec()` 中追加创建 `ai_ratio_history` 表和索引
    - 追加 `CREATE TABLE IF NOT EXISTS ai_ratio_history` 语句，包含 `id`, `repo_name`, `recorded_at`, `ai_ratio`, `ai_additions`, `human_additions`, `mixed_additions`, `commit_sha` 列
    - 追加 `CREATE INDEX IF NOT EXISTS idx_ai_ratio_history_repo_time ON ai_ratio_history(repo_name, recorded_at)`
    - 确保不影响现有表的创建逻辑
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 1.2 安装测试依赖 vitest 和 fast-check
    - 在 `agent-support/kiro-dashboard/` 下运行 `npm install --save-dev vitest fast-check`
    - 在 `package.json` 中添加 `"test": "vitest --run"` 脚本
    - _Requirements: 测试基础设施_

- [x] 2. Store 层核心函数实现
  - [x] 2.1 在 `store.js` 中新增 `recordAiRatioSnapshot(repoName, commitSha)` 函数
    - 使用 `db.prepare` 查询 `commits` 表中该仓库的 `SUM(ai_additions)`, `SUM(human_additions)`, `SUM(mixed_additions)`
    - 计算 `ai_ratio = ai / (ai + human + mixed)`，当总量为零时跳过插入
    - 插入一条记录到 `ai_ratio_history`，`recorded_at` 使用当前 ISO 时间戳
    - 该函数设计为在事务内被调用，不自行开启事务
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 2.2 修改 `saveStats(payload)` 函数，在事务末尾调用 `recordAiRatioSnapshot`
    - 在现有 `db.transaction()` 回调的末尾，追加调用 `recordAiRatioSnapshot(p.repo_name, p.commit_sha)`
    - 确保快照插入与 commit 保存在同一事务中
    - _Requirements: 2.4_

  - [x] 2.3 编写属性测试：累计 AI 占比快照正确性
    - **Property 1: Cumulative AI ratio snapshot correctness**
    - 使用 fast-check 生成随机 commit 序列（ai/human/mixed 为 0~10000 的整数），逐条调用 `saveStats` 后验证最新快照的 `ai_ratio` 等于 `SUM(ai_additions) / SUM(ai_additions + human_additions + mixed_additions)`
    - 测试文件：`agent-support/kiro-dashboard/src/__tests__/store.property.test.js`
    - **Validates: Requirements 2.1, 2.2**

  - [x] 2.4 编写单元测试：累计总量为零时不插入快照
    - 测试当仓库所有 commit 的 ai + human + mixed 均为 0 时，`ai_ratio_history` 表无新增记录
    - 测试文件：`agent-support/kiro-dashboard/src/__tests__/store.test.js`
    - _Requirements: 2.3_

- [x] 3. Store 层查询函数与回填
  - [x] 3.1 在 `store.js` 中新增 `getAiRatioHistory(repoName)` 函数
    - 查询 `ai_ratio_history` 表，按 `recorded_at ASC` 排序
    - 返回包含 `recorded_at`, `ai_ratio`, `ai_additions`, `human_additions`, `mixed_additions`, `commit_sha` 字段的数组
    - 查询失败时捕获异常，打印日志，返回空数组
    - 将函数添加到 `module.exports`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 3.2 在 `store.js` 中新增 `backfillAiRatioHistory()` 函数并在模块初始化时调用
    - 检查 `ai_ratio_history` 表是否为空，非空则跳过
    - 查询所有 commits 按 `COALESCE(reported_at, created_at)` ASC 排序
    - 按 `repo_name` 维护累计器，逐条计算 running cumulative ratio 并插入快照
    - 整个回填操作在一个事务中执行
    - 在 `db.exec()` 建表语句之后立即调用此函数
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 3.3 编写属性测试：API 返回排序和字段完整性
    - **Property 2: History API response ordering and completeness**
    - 使用 fast-check 生成随机时间戳的历史记录，直接插入 `ai_ratio_history` 表，调用 `getAiRatioHistory` 后验证返回结果按 `recorded_at` 升序排列，且每条记录包含所有必需字段
    - 测试文件：`agent-support/kiro-dashboard/src/__tests__/store.property.test.js`
    - **Validates: Requirements 3.1, 3.2**

  - [x] 3.4 编写属性测试：回填累计比率正确性
    - **Property 3: Backfill running cumulative ratio correctness**
    - 使用 fast-check 生成多仓库随机 commit 集合，插入 commits 表后执行回填，验证每条快照的 `ai_ratio` 等于该仓库截至该 commit 的 running cumulative ratio，且快照总数等于非零累计总量的 commit 数
    - 测试文件：`agent-support/kiro-dashboard/src/__tests__/store.property.test.js`
    - **Validates: Requirements 5.1, 5.2**

  - [x] 3.5 编写单元测试：查询与回填边界场景
    - 测试无历史记录的仓库返回空数组
    - 测试不存在的仓库返回空数组
    - 测试回填只执行一次（幂等性）：第二次调用不新增记录
    - 测试文件：`agent-support/kiro-dashboard/src/__tests__/store.test.js`
    - _Requirements: 3.3, 3.4, 5.3_

- [x] 4. 检查点 - 确保 Store 层测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [x] 5. Dashboard API 路由
  - [x] 5.1 在 `agent-support/kiro-dashboard/src/dashboard.js` 中新增 `/api/repos/:name/ai-ratio-history` 路由
    - 在现有 `/api/repos/` 路由分支中，检查路径是否以 `/ai-ratio-history` 结尾
    - 该路由优先于 `/aggregate` 分支处理
    - 从 store 导入 `getAiRatioHistory`，调用后返回 JSON 数组，HTTP 200
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 6. 前端 Chart.js 图表渲染
  - [x] 6.1 在 `agent-support/kiro-dashboard/public/index.html` 的 `<head>` 中引入 Chart.js CDN，新增 `renderAiRatioChart` 函数
    - 在 `<head>` 中添加 `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`
    - 新增 `renderAiRatioChart(container, data)` 函数，使用 Chart.js Line chart API 渲染折线图
    - 数据点 < 2 时显示 "数据不足，暂无趋势图" 文字提示
    - X 轴显示日期（`toLocaleDateString("zh-CN")`），Y 轴显示 AI 占比百分比 (0%~100%)
    - 折线颜色 `#58a6ff`，填充色 `rgba(88, 166, 255, 0.1)`，`tension: 0.3`
    - 配置 `responsive: true`，隐藏 legend
    - 坐标轴 ticks 颜色 `#8b949e`，grid 颜色 `#21262d`，与暗色主题一致
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 6.2 配置 Chart.js 内置 tooltip，悬停显示日期和 AI 占比百分比
    - 在 Chart.js options.plugins.tooltip 中配置 `callbacks.label` 显示 "AI 占比: X%"
    - Chart.js 内置 tooltip 支持，无需手动实现 mousemove 事件监听
    - _Requirements: 4.6_

  - [x] 6.3 在 `showDetail()` 函数中集成图表
    - 在"汇总统计"表格之后、"按开发者"表格之前插入 `<div class="section-title">AI 占比趋势</div>` 和图表容器 `<div id="ai-ratio-chart"></div>`
    - 在 `content.innerHTML = html` 之后，调用 `fetch` 获取 `/api/repos/:name/ai-ratio-history` 数据
    - 调用 `renderAiRatioChart` 渲染图表，fetch 失败时在容器中显示错误信息
    - Chart.js CDN 加载失败时降级显示 "图表加载失败" 提示
    - _Requirements: 4.1, 4.5_

- [x] 7. 最终检查点 - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

## Notes

- 标记 `*` 的子任务为可选测试任务，可跳过以加速 MVP 交付
- 每个任务引用了具体的需求条款以确保可追溯性
- 属性测试验证设计文档中定义的正确性属性
- 单元测试覆盖边界场景和错误处理
- 检查点确保增量验证
- 实现语言为 JavaScript (Node.js CommonJS)，与现有代码风格一致
- 前端图表使用 Chart.js（CDN 引入），替代原生 Canvas 手动绘制，大幅减少代码量和潜在 bug
