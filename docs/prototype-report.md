# 快速原型报告

**项目名称：** Kiro Coding Metrics Collector

**日期：** 2026年5月

---

## Notices

Customers are responsible for making their own independent assessment of the information in this document. This document: (a) is for informational purposes only, (b) represents current AWS product offerings and practices, which are subject to change without notice, and (c) does not create any commitments or assurances from AWS and its affiliates, suppliers or licensors. AWS products or services are provided "as is" without warranties, representations, or conditions of any kind, whether express or implied. The responsibilities and liabilities of AWS to its customers are controlled by AWS agreements, and this document is not part of, nor does it modify, any agreement between AWS and its customers.

© 2025 Amazon Web Services, Inc. or its affiliates. All rights reserved.

---

## 目录 / Contents

1. [Background（项目背景）](#1-background项目背景)
2. [Scope of Work（工作范围）](#2-scope-of-work工作范围)
3. [Architecture（架构设计）](#3-architecture架构设计)
4. [Deployment Documentation（部署文档）](#4-deployment-documentation部署文档)
5. [Prototype Summary（原型成果）](#5-prototype-summary原型成果)
6. [Security Recommendations（安全建议）](#6-security-recommendations安全建议)
7. [Appendix（附录）](#7-appendix附录)

---

## 1. Background（项目背景）

企业在大规模采用 AI 编程工具（如 Kiro IDE）后，面临一个关键问题：缺少对 AI 相关的代码覆盖率指标（AI/人工/混合编程模式下的新增/删除代码行数）的采集和展示功能，无法量化评估 AI 工具对研发效能的实际贡献。

本原型项目通过开发 Kiro IDE 插件和 Dashboard Web 应用，在 Kiro IDE 中采集 AI 相关代码覆盖率指标并发送到远程 Dashboard 应用采集端口。Dashboard 应用使用数据库来处理代码仓库指标和用户监控数据，在前端 Dashboard 页面展示每个项目和员工的代码覆盖率指标，从而帮助管理人员更精准地评估 AI 工具和研发人员的研发效能。

### 核心需求

| 需求类别 | 说明 |
|---------|------|
| 代码归属追踪 | 精确区分 AI 生成代码、人工编写代码、混合编辑代码的行级归属 |
| 指标采集 | 在 commit 时自动计算并上报各类代码行数指标 |
| 用户管理 | 通过 IAM Identity Center 同步用户，监控插件安装率和 Credit 用量 |
| 数据展示 | 提供 Web Dashboard 展示项目级和人员级的代码覆盖率指标 |
| 跨平台支持 | 支持 macOS、Windows、Linux 三个操作系统 |

---

## 2. Scope of Work（工作范围）

本原型项目交付一个可运行的最小可行系统（MVP），验证核心功能的技术可行性和用户体验。

### 2.1 交付物清单

| 交付物 | 格式 | 说明 |
|--------|------|------|
| Kiro IDE 插件 | VSIX | 内置 macOS、Windows、Linux 的 git-ai 二进制 |
| Dashboard 服务 | Node.js 应用 | 含 ingest API、查询 API、定时同步任务、前端页面 |
| 架构设计文档 | Markdown + draw.io | 数据流程图和部署架构图 |
| 原型报告 | 本文 | 技术方案、部署说明、安全建议 |

### 2.2 指标统计范围

本系统采集的代码行数统计指标如下：

| 指标 | 字段名 | 说明 |
|------|--------|------|
| 人工新增行数 | human_additions | 人类编写且提交的代码行数 |
| AI 新增行数 | ai_additions | AI 生成且提交的代码行数（纯 AI，不含 mixed） |
| 混合新增行数 | mixed_additions | AI 编写后人工修改的行数 |
| AI 原样接受行数 | ai_accepted | AI 生成且被人类原样接受的行数 |
| AI 删除行数 | ai_deletions | AI 在工作过程中删除的行数 |
| 人工删除行数 | human_deletions | 人工删除的行数 |
| 总新增行数 | git_diff_added_lines | git diff 统计的总新增行数 |
| 总删除行数 | git_diff_deleted_lines | git diff 统计的总删除行数 |
| AI 占比 | 计算值 | ai_additions / (ai_additions + human_additions) |
| AI 占比历史趋势 | 计算值 | 按 commit 累计计算，支持折线图展示 |

### 2.3 支持的操作场景

指标统计在 Windows、macOS、Linux 系统上的 Kiro IDE 内的常规操作均能正确统计，包括：

- 通过 vibe coding 或 spec 模式新增代码文件或新增、修改、删除代码
- 人工新增代码文件或新增、修改、删除代码
- AI 新增代码文件或新增、修改、删除代码后人工参与新增、修改、删除代码
- 文件改名、移动位置
- 代码合并、rebase、解决冲突等代码协同操作
- 以子目录作为 Kiro 工作区
- 以父目录作为 Kiro 工作区（含多个 git 仓库）
- 在命令行或其他 IDE 执行代码 commit 操作
- 特定工程化目录（out、dist、node_modules、.nuxt、.gradle 等）不计入统计

### 2.4 VSCode 插件核心功能

#### 用户身份识别

插件启动后初始化 git-ai CLI 工具，通过三级 fallback 获取用户 email：
1. `kiro-cli whoami`
2. CodeWhisperer `getUsageLimits` API
3. `git config user.email`

连同客户端 IP 和本机 hostname 上报到 Dashboard 服务。上报每 4 小时定时执行一次以维持活跃状态。

#### AI 编辑检测

插件实时监听 Kiro IDE 持久化到磁盘的 Execution Log 文件（支持 Format A 和 Format B 两种日志格式），解析 AI 代码编辑记录（包括 fsWrite、strReplace、fsAppend、deleteFile 等工具调用），提取编辑前后的文件内容。

检测到 AI 编辑后，依次执行 human checkpoint（携带编辑前内容）和 AI checkpoint（携带当前内容），通过 `git-ai checkpoint agent-v1` 将行级归属信息写入本地 working log。支持按 git 仓库分组路由 checkpoint，确保多仓库工作区下路径一致性。

**Execution Log 存储位置（跨平台）：**

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/` |
| Windows | `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\` |
| Linux | `~/.config/Kiro/User/globalStorage/kiro.kiroagent/` |

#### Commit 检测与上报

当检测到新的本地 git commit 时（通过 VSCode Git 扩展 API 监听 HEAD 变化，reflog 排除非本地操作），通过 git post-commit hook 在后台执行 `git-ai post-commit` 将 working logs 转为 Git Notes，再调用 `git-ai stats` 获取该 commit 的归属统计（含工具模型细分），并通过 `git-ai diff --json` 精确计算 AI/人工删除行数，最终通过 HTTP POST 上报到 Dashboard。

hook 脚本同时支持 Unix（bash + python3 解析）和 Windows（PowerShell 原生解析）。

### 2.5 Dashboard Web 应用功能

#### 数据存储

使用本地 SQLite 数据库（WAL 模式），包含 commits、tool_model_stats、sessions、plugins、kiro_user 等核心表，支持 schema 自动迁移。

#### 数据采集接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/v1/stats` | POST | 接收插件上报的 commit 指标数据，支持幂等性去重（X-Idempotency-Key） |
| `/api/v1/userSync` | POST | 接收用户活跃信息和 hostname |

#### 用户管理

- 从 IAM Identity Center 同步用户列表到本地表
- 从 CloudTrail 查询 CreateToken 事件获取用户 SSO 登录 session（首次启动获取近 30 天，此后每日增量同步并清理过期 session）
- 通过 plugins 表记录插件活跃设备（按 hostname 去重）

#### Credit 用量同步

启动时/每小时定时从 Kiro 关联的 S3 桶同步 credit 用量数据，记录到用户表中。

#### 数据查询 API

| 接口 | 方法 | 说明 |
|------|------|------|
| `GET /api/repos` | GET | 所有仓库概览列表，包括汇总的代码行数指标 |
| `GET /api/repos/:name/aggregate` | GET | 单仓库聚合统计数据，包括汇总统计和按开发者分组统计 |
| `GET /api/repos/:name` | GET | 单仓库 commit 历史记录 |
| `GET /api/repos/:name/ai-ratio-history` | GET | AI 占比历史趋势数据 |
| `GET /api/users` | GET | 用户统计数据，包括 Kiro 和插件使用情况 |

---

## 3. Architecture（架构设计）

### 3.1 整体架构

本项目采用"本地插件 + 远程 Dashboard"的架构模式：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        开发者本地环境                                  │
│                                                                     │
│  ┌──────────────────────┐     ┌──────────────────────────────────┐  │
│  │     Kiro IDE          │     │         Git 仓库                  │  │
│  │                       │     │                                  │  │
│  │  ┌─────────────────┐ │     │  .git/ai/working_logs/           │  │
│  │  │ git-ai-kiro 插件 │ │────▶│    <base_commit>/                │  │
│  │  │                  │ │     │      checkpoints.jsonl           │  │
│  │  │ • SessionLog     │ │     │      blobs/<sha256>              │  │
│  │  │   Watcher        │ │     │                                  │  │
│  │  │ • Checkpoint     │ │     │  .git/hooks/post-commit          │  │
│  │  │ • CommitWatcher  │ │     │    (bash/PowerShell)             │  │
│  │  │ • StatsUploader  │ │     └──────────────────────────────────┘  │
│  │  │ • UserSync       │ │                                           │
│  │  └─────────────────┘ │                                           │
│  └──────────────────────┘                                           │
│                                                                     │
│  ┌──────────────────────┐                                           │
│  │  git-ai CLI (Rust)   │  ← 内置于插件 VSIX（三平台二进制）          │
│  │  • checkpoint        │                                           │
│  │  • post-commit       │                                           │
│  │  • stats             │                                           │
│  │  • diff              │                                           │
│  └──────────────────────┘                                           │
└─────────────────────────────────────────────────────────────────────┘
                │                                    │
                │ HTTP POST /api/v1/stats             │ HTTP POST /api/v1/userSync
                ▼                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Dashboard 服务（Node.js）                         │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Ingest API   │  │ Query API    │  │ 定时同步任务               │  │
│  │              │  │              │  │                          │  │
│  │ POST /stats  │  │ GET /repos   │  │ • IAM IdC 用户同步       │  │
│  │ POST /user   │  │ GET /users   │  │ • CloudTrail Session     │  │
│  │   Sync       │  │ GET /repos/  │  │ • S3 Credit 用量         │  │
│  │              │  │   :name/agg  │  │                          │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │
│         │                  │                       │                 │
│         ▼                  ▼                       ▼                 │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                SQLite 数据库 (WAL 模式)                       │    │
│  │  commits | tool_model_stats | kiro_user | sessions | plugins │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              前端 Dashboard (index.html + Chart.js)           │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ AWS SDK
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          AWS 服务                                     │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ IAM Identity     │  │ CloudTrail   │  │ S3                   │  │
│  │ Center           │  │              │  │                      │  │
│  │ • ListUsers      │  │ • LookupEvts │  │ • User Activity      │  │
│  │ • 用户认证管理    │  │ • CreateToken│  │   Report (CSV)       │  │
│  └──────────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 数据流程

#### 代码归属追踪流程

```
AI 编辑代码 ──▶ Kiro 写入 Execution Log ──▶ SessionLogWatcher 检测
                                                      │
                                                      ▼
                                            解析 WriteAction
                                            (Format A / Format B)
                                                      │
                                                      ▼
                                            按 git repo 路由分组
                                                      │
                                                      ▼
                                    ┌─────────────────────────────────┐
                                    │ git-ai checkpoint agent-v1      │
                                    │ • human checkpoint (编辑前内容)  │
                                    │ • AI checkpoint (当前内容)       │
                                    └─────────────────────────────────┘
                                                      │
                                                      ▼
                                    .git/ai/working_logs/<base>/checkpoints.jsonl
```

#### Commit 统计上报流程

```
git commit ──▶ post-commit hook 触发
                      │
                      ▼
              git-ai post-commit
              (working_logs → Git Notes)
                      │
                      ▼
              git-ai stats <sha> --json
              (计算归属统计)
                      │
                      ▼
              git-ai diff <sha> --json
              (精确计算 AI/人工删除行数)
                      │
                      ▼
              HTTP POST /api/v1/stats
              (上报到 Dashboard)
```

### 3.3 核心统计算法

commit 时的指标计算逻辑：

1. 获取 commit 的 parent commit SHA
2. 读取 parent commit 目录下的 `checkpoints.jsonl`（所有 checkpoint 记录）
3. 通过 `git diff -U0` 获取本次 commit 中每个文件实际新增的行号
4. 从 checkpoints 中构建每个文件的最终行级归属映射（后面的 checkpoint 覆盖前面的）
5. 取交集计算：
   - `ai_accepted` = commit 新增行 ∩ AI 归属行（无 overrode）
   - `mixed_additions` = commit 新增行 ∩ 有 overrode 标记的行
   - `ai_additions` = ai_accepted（纯 AI 行数，不含 mixed）
   - `human_additions` = git_diff_added_lines - ai_accepted
   - `ai_deletions` / `human_deletions` = 通过 `git-ai diff --json` 的 hunks 精确计算

### 3.4 主要涉及的服务

#### AWS 服务

| 服务 | 用途 |
|------|------|
| Kiro IDE | Kiro 编程客户端 |
| IAM Identity Center | Kiro 用户认证管理，同步用户列表 |
| S3 | 存储 Kiro 用户的 Credit 用量报告 |
| CloudTrail | 查询用户 SSO 登录 session（CreateToken 事件） |

#### 第三方服务/工具

| 服务/工具 | 用途 |
|-----------|------|
| Git | 代码版本管理系统 |
| git-ai | AI/人工代码归属记录工具（Rust 编写，支持 macOS、Windows、Linux） |

#### 开发依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| AWS JavaScript SDK v3 | ^3.1030+ | 访问 IAM IdC、CloudTrail、S3 |
| better-sqlite3 | ^12.8.0 | 本地 SQLite 数据库 |
| Chart.js | CDN | 前端图表展示 |
| TypeScript | ^5.8.3 | 插件开发语言 |
| Vitest | ^4.1.4 | 单元测试框架 |

---

## 4. Deployment Documentation（部署文档）

### 4.1 前提条件

| 条件 | 说明 |
|------|------|
| Kiro IDE | 已安装 Kiro IDE（版本 >= 1.99.3） |
| Node.js | >= 20.x（Dashboard 服务运行环境） |
| Git | 已安装 git 命令行工具 |
| Python 3 | Unix 系统上 post-commit hook 需要 python3 解析 JSON |
| AWS 凭证 | 具有 IAM Identity Center、CloudTrail、S3 读取权限的 AKSK |
| 网络 | 开发者机器可访问 Dashboard 服务的 HTTP 端口 |

### 4.2 Dashboard 服务部署

#### 环境变量配置

创建 `.env` 文件（参考 `.env.example`）：

```bash
# AWS 配置
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=wJal...

# IAM Identity Center
IDENTITY_STORE_ID=d-90xxx

# S3 Credit 报告（可选，如无 credit 监控需求可不配置）
KIRO_S3_BUCKET=my-kiro-bucket
KIRO_S3_PREFIX=kiro-logs/
KIRO_ACCOUNT_ID=020446257700

# 服务端口
PORT=3000
```

#### 启动服务

```bash
cd kiro-dashboard
npm install
npm start
```

服务启动后：
- Ingest API 监听 `POST /api/v1/stats` 和 `POST /api/v1/userSync`
- Query API 监听 `GET /api/repos`、`GET /api/users` 等
- 前端 Dashboard 页面访问 `http://<host>:3000`
- 自动执行 IAM Identity Center 用户同步
- 自动执行 CloudTrail Session 同步（首次 30 天，此后每日增量）
- 自动执行 S3 Credit 用量同步（每小时）

#### IAM 权限要求

运行 Dashboard 的 IAM 身份需要以下权限：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "identitystore:ListUsers"
      ],
      "Resource": [
        "arn:aws:identitystore::${AccountId}:identitystore/${IdentityStoreId}",
        "arn:aws:identitystore:::user/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudtrail:LookupEvents"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "${AWS_REGION}"
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetObject"
      ],
      "Resource": [
        "arn:aws:s3:::${KIRO_S3_BUCKET}",
        "arn:aws:s3:::${KIRO_S3_BUCKET}/*"
      ]
    }
  ]
}
```

### 4.3 Kiro IDE 插件安装

#### 安装步骤

1. 获取插件 VSIX 文件（`git-ai-kiro-0.1.2.vsix`）
2. 在 Kiro IDE 中：`Extensions` → `...` → `Install from VSIX...`
3. 选择 VSIX 文件安装
4. 重启 Kiro IDE

#### 插件自动行为

安装后插件自动执行以下操作：
- 初始化 git-ai CLI 二进制（从 VSIX 内置的平台对应二进制解压）
- 发现工作区内的 git 仓库（支持子目录和父目录场景）
- 安装 post-commit hook 到每个发现的 git 仓库
- 启动 SessionLogWatcher 监听 Kiro Execution Log 目录
- 启动 UserSync 定时上报（每 4 小时）
- 获取用户 email 并上报到 Dashboard

#### 插件配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `gitai.kiro.enableCheckpointLogging` | boolean | false | 启用 checkpoint 创建通知 |
| `gitai.kiro.ignorePatterns` | string[] | [见下方] | 排除的文件/目录模式 |

默认排除模式包括：node_modules、dist、build、out、.next、target、vendor、coverage、__pycache__、*.lock、package-lock.json、*.min.js、*.min.css、*.map 等。

### 4.4 验证部署

1. **插件验证**：打开 Kiro 开发者工具（`Help > Toggle Developer Tools`），过滤 `[git-ai-kiro]`，确认日志输出正常
2. **Hook 验证**：检查 `.git/hooks/post-commit` 文件是否包含 `git-ai-kiro` marker
3. **上报验证**：执行一次 commit 后，检查 `.git/ai/last_upload_payload.json` 中的上报记录
4. **Dashboard 验证**：访问 `http://<host>:3000`，确认数据展示正常

---

## 5. Prototype Summary（原型成果）

### 5.1 交付物清单

| 交付物 | 路径 | 说明 |
|--------|------|------|
| Kiro IDE 插件源码 | `kiro-plugin/` | TypeScript 源码，含 SessionLogWatcher、Checkpoint、CommitWatcher 等模块 |
| 插件 VSIX 包 | `kiro-plugin/git-ai-kiro-0.1.2.vsix` | 可直接安装的插件包（内置三平台 git-ai 二进制） |
| Dashboard 服务 | `kiro-dashboard/` | Node.js 应用，含 ingest API、查询 API、前端页面 |
| 架构设计文档 | `docs/` | 流程图、测试方案、本报告 |
| 原型报告 | `docs/prototype-report.md` | 本文 |

### 5.2 插件核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| SessionLogWatcher | `src/sessionLogWatcher.ts` | 实时监听 Kiro Execution Log 目录变化，触发 AI 编辑检测和 checkpoint |
| SessionLogParser | `src/sessionLogParser.ts` | 解析 Execution Log（Format A/B），提取 WriteAction |
| SessionLogScanner | `src/sessionLogScanner.ts` | 日志扫描协调器，编排文件系统操作和过滤逻辑 |
| Checkpoint | `src/checkpoint.ts` | git-ai CLI 二进制初始化（三平台）、checkpoint 调用 |
| CheckpointPayload | `src/checkpointPayload.ts` | 从 WriteAction 构建 AICheckpointPayload |
| CommitWatcher | `src/commitWatcher.ts` | 监听 git commit（依赖 vscode.git 扩展 API） |
| RepoRouter | `src/repoRouter.ts` | WriteAction 按 git repo 分组、路径转换 |
| GitUtils | `src/gitUtils.ts` | findGitRoot、findGitReposInDir、hook 安装、hook 脚本生成 |
| StatsUploader | `src/statsUploader.ts` | HTTP POST 上报到 Dashboard（含重试和幂等性） |
| UserSync | `src/userSync.ts` | 用户信息上报（email/IP/hostname）、定时机制 |
| WorkspacePathEncoder | `src/workspacePathEncoder.ts` | workspace 路径 URL-safe Base64 编解码 |
| ApiConfig | `src/apiConfig.ts` | 硬编码的 Dashboard API URL |
| StatusBar | `src/statusBar.ts` | 状态栏显示 |

### 5.3 Dashboard 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| Main | `src/main.js` | 服务入口，启动 HTTP 服务器和定时任务 |
| Ingest | `src/ingest.js` | 接收 commit 指标数据（POST /api/v1/stats） |
| Dashboard | `src/dashboard.js` | 查询 API（GET /api/repos、GET /api/users） |
| Store | `src/store.js` | SQLite 数据库操作封装 |
| Migrate | `src/migrate.js` | 数据库 schema 自动迁移 |
| IdentityCenter | `src/identityCenter.js` | IAM Identity Center 用户同步 |
| SessionSync | `src/sessionSync.js` | CloudTrail Session 同步 |
| CreditSync | `src/creditSync.js` | S3 Credit 用量同步 |
| Auth | `src/auth.js` | 请求鉴权 |
| RequestLogger | `src/requestLogger.js` | 请求日志记录 |

### 5.4 测试覆盖

#### 单元测试

插件端使用 Vitest 框架，覆盖核心归属追踪逻辑：
- `line-diff`：7 个场景（空文件、新增、删除、修改、混合）
- `attribution-tracker`：10 个场景（AI/人工新增、混合、删除、多 session、三方交替）
- `ignore-patterns`：15 个场景（各类工程化目录和文件过滤）

#### 手动测试方案

设计了 60 个测试用例，覆盖以下场景类别：
1. 基础场景（AI/人工纯新增、纯删除、纯修改、新文件）
2. 混合编辑场景（AI 后人工修改、人工后 AI 修改、不同文件）
3. 多次编辑场景（多次 AI 编辑、AI 新增后删除）
4. 文件重命名/移动场景
5. AI/人工删除行数精确统计场景
6. Git 操作过滤场景（pull/merge/rebase 不上报）
7. 工程化目录过滤场景
8. 父/子目录打开场景
9. post-commit hook 场景
10. 上报服务场景
11. 边界场景

### 5.5 已知限制

| 限制 | 说明 |
|------|------|
| IDE 自动重构不被追踪 | 文件改名时 IDE 自动修改类名不经过 Kiro Execution Log，归属不确定 |
| Kiro IDE 无 vscode.git extension | CommitWatcher 在 Kiro IDE 中不工作（通过 post-commit hook 补偿） |
| mixed_additions 精确性 | 依赖 git-ai 核心的 `overriden_lines` 计算，插件端无法改善 |
| Execution Log 格式无保证 | 这些日志是 Kiro 的内部实现，版本升级后格式可能变化 |
| 日志可能被清理 | Kiro 可能有缓存清理机制，旧的执行日志可能被删除 |

---

## 6. Security Recommendations（安全建议）

### 6.1 IAM 与权限管理

| 建议 | 说明 |
|------|------|
| 最小权限原则 | Dashboard 服务的 IAM 身份仅授予 `identitystore:ListUsers`、`cloudtrail:LookupEvents`、`s3:ListBucket`/`s3:GetObject` 权限 |
| 凭证轮换 | 定期轮换 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY，建议使用 IAM Role 替代长期凭证 |
| 环境变量保护 | `.env` 文件不应提交到版本控制，已在 `.gitignore` 中排除 |
| 权限审计 | 定期审查 IAM 策略，移除不再需要的权限 |

### 6.2 网络安全

| 建议 | 说明 |
|------|------|
| HTTPS 传输 | 插件与 Dashboard 之间的通信建议使用 HTTPS，防止数据在传输中被窃取 |
| 网络隔离 | Dashboard 服务建议部署在内网环境，通过 VPN 或安全组限制访问 |
| TLS 版本 | Windows PowerShell hook 已强制 TLS 1.2（`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`） |
| API 鉴权 | Ingest API 支持 Bearer Token 鉴权，建议在生产环境启用 |

### 6.3 数据安全

| 建议 | 说明 |
|------|------|
| 数据库访问控制 | SQLite 数据库文件权限应限制为服务运行用户可读写 |
| 幂等性去重 | Ingest API 通过 X-Idempotency-Key 防止重复写入，key 建议 24 小时后过期 |
| 敏感数据处理 | 上报数据中不包含代码内容，仅包含行数统计指标 |
| 日志保留 | 建议设置日志保留策略（当前 `.git/ai/last_upload_payload.json` 自动清理 15 天前记录） |
| XSS 防护 | Dashboard 前端已对所有动态数据进行 HTML 转义，防止跨站脚本攻击 |

### 6.4 插件安全

| 建议 | 说明 |
|------|------|
| 二进制完整性 | git-ai CLI 二进制内置于 VSIX 包中，建议对二进制进行签名验证 |
| 文件系统访问 | 插件仅读取 Kiro Execution Log 目录和 git 仓库目录，不访问其他敏感路径 |
| 进程隔离 | git-ai CLI 通过 `execFileSync` 调用，设置超时（5-15 秒）防止进程挂起 |
| 错误处理 | 所有外部调用（git 命令、HTTP 请求）均有 try-catch 包裹，失败时静默处理不影响 IDE 使用 |

### 6.5 生产化建议

| 建议 | 优先级 | 说明 |
|------|--------|------|
| 使用 IAM Role 替代 AKSK | 高 | 如部署在 EC2/ECS 上，使用实例角色避免硬编码凭证 |
| 启用 CloudTrail 数据平面事件 | 中 | 监控 SQLite 数据库的异常访问模式 |
| 添加 WAF 防护 | 中 | 如 Dashboard 暴露在公网，添加 AWS WAF 防护 |
| 数据库加密 | 中 | 考虑使用 SQLCipher 对 SQLite 数据库进行加密 |
| 审计日志 | 中 | 记录所有 API 访问日志，保留期 >= 90 天 |
| 插件签名 | 低 | 对 VSIX 包进行代码签名，确保分发完整性 |

---

## 7. Appendix（附录）

### 7.1 数据库 Schema

#### commits 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER (PK) | 自增主键 |
| repo_name | TEXT | 仓库名称 |
| repo_remote_url | TEXT | git remote URL |
| branch | TEXT | 分支名 |
| commit_sha | TEXT | commit SHA |
| machine_id | TEXT | 机器标识 |
| user_name | TEXT | 用户名 |
| user_email | TEXT | 用户 email |
| reported_at | TEXT | 上报时间 (ISO 8601) |
| human_additions | INTEGER | 人工新增行数 |
| ai_additions | INTEGER | AI 新增行数 |
| mixed_additions | INTEGER | 混合新增行数 |
| ai_accepted | INTEGER | AI 原样接受行数 |
| total_ai_additions | INTEGER | AI 过程总新增行数 |
| total_ai_deletions | INTEGER | AI 过程总删除行数 |
| ai_deletions | INTEGER | AI 精确删除行数 |
| human_deletions | INTEGER | 人工精确删除行数 |
| time_waiting_for_ai | INTEGER | 等待 AI 时间（秒） |
| git_diff_added_lines | INTEGER | git diff 新增行数 |
| git_diff_deleted_lines | INTEGER | git diff 删除行数 |

#### kiro_user 表

| 字段 | 类型 | 说明 |
|------|------|------|
| user_name | TEXT (PK) | 用户 email，主键 |
| user_id | TEXT | IAM Identity Center UserId |
| created_at | TEXT | 记录创建时间 |
| user_ip | TEXT | 最近一次上报的客户端 IP |
| credit_used | TEXT | JSON 格式的按日期 Credit 用量 |
| updated_at | TEXT | 最后活跃时间 |

#### sessions 表

| 字段 | 类型 | 说明 |
|------|------|------|
| session_id | TEXT (PK) | SSO 应用会话 ID |
| user_id | TEXT | IAM Identity Center UserId |
| expire_time | TEXT | 会话过期时间 |

#### plugins 表

| 字段 | 类型 | 说明 |
|------|------|------|
| hostname | TEXT (PK) | 客户端主机名 |
| user_name | TEXT | 用户 email |
| ip | TEXT | 客户端 IP |
| last_updated | TEXT | 最后上报时间 |

### 7.2 API 接口汇总

#### Ingest API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/v1/stats` | POST | 接收 commit 指标数据 |
| `/api/v1/userSync` | POST | 接收用户活跃信息 |

#### Query API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/repos` | GET | 所有仓库概览 |
| `/api/repos/:name` | GET | 单仓库 commit 历史 |
| `/api/repos/:name/aggregate` | GET | 单仓库聚合统计 |
| `/api/repos/:name/ai-ratio-history` | GET | AI 占比趋势 |
| `/api/users` | GET | 用户管理数据 |

### 7.3 Execution Log 格式说明

#### Format A（Autopilot / Spec 工作流）

包含 `actions` 数组，每个 action 记录完整的工具调用信息：

```json
{
  "executionId": "...",
  "workflowType": "chat-agent",
  "status": "succeed",
  "actions": [
    {
      "actionType": "replace",
      "actionState": "Accepted",
      "input": {
        "file": "src/index.ts",
        "originalContent": "...(修改前完整内容)",
        "modifiedContent": "...(修改后完整内容)"
      }
    }
  ]
}
```

支持的 actionType：`replace`、`create`、`write`、`append`、`editCode`、`delete`、`smartRelocate`

#### Format B（Chat 工作流）

工具调用信息嵌套在 `context.messages` 中：

```json
{
  "executionId": "...",
  "context": {
    "messages": [
      {
        "role": "bot",
        "entries": [
          { "type": "toolUse", "name": "fsWrite", "args": { "path": "...", "text": "..." } }
        ]
      }
    ]
  }
}
```

### 7.4 post-commit hook 脚本结构

#### Unix (bash + python3)

```bash
#!/bin/bash
# === git-ai-kiro START ===
COMMIT_SHA=$(git rev-parse HEAD)
GIT_AI_BIN="<path-to-git-ai>"
"$GIT_AI_BIN" post-commit
STATS_JSON=$("$GIT_AI_BIN" stats "$COMMIT_SHA" --json)
DIFF_JSON=$("$GIT_AI_BIN" diff "$COMMIT_SHA" --json)
# python3 解析 JSON 并计算最终指标
python3 -c "
import json, sys, urllib.request
# ... 解析 stats 和 diff，计算 ai_deletions/human_deletions
# ... HTTP POST 到 Dashboard
"
# === git-ai-kiro END ===
```

#### Windows (PowerShell)

```powershell
# === git-ai-kiro START ===
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$commitSha = git rev-parse HEAD
$gitAiBin = "<path-to-git-ai.exe>"
& $gitAiBin post-commit
$statsJson = & $gitAiBin stats $commitSha --json | Out-String
$diffJson = & $gitAiBin diff $commitSha --json | Out-String
# PowerShell 原生 JSON 解析
$stats = $statsJson | ConvertFrom-Json
# ... 计算最终指标并 HTTP POST
# === git-ai-kiro END ===
```

### 7.5 项目文件结构

```
ai-code-coverage-collector/
├── kiro-plugin/                          # Kiro IDE 插件
│   ├── bin/                             # git-ai 二进制（三平台）
│   │   ├── git-ai                       # macOS (darwin-arm64)
│   │   ├── git-ai-linux                 # Linux (x86_64)
│   │   └── git-ai.exe                   # Windows (x64)
│   ├── src/                             # TypeScript 源码
│   │   ├── extension.ts                 # 插件入口
│   │   ├── sessionLogWatcher.ts         # AI 编辑检测
│   │   ├── sessionLogParser.ts          # Execution Log 解析
│   │   ├── sessionLogScanner.ts         # 日志扫描协调
│   │   ├── checkpoint.ts                # git-ai CLI 调用
│   │   ├── checkpointPayload.ts         # Checkpoint 数据构建
│   │   ├── commitWatcher.ts             # Commit 检测
│   │   ├── repoRouter.ts               # 多仓库路由
│   │   ├── gitUtils.ts                  # Git 工具函数 + Hook 生成
│   │   ├── statsUploader.ts             # 指标上报
│   │   ├── userSync.ts                  # 用户同步
│   │   ├── apiConfig.ts                 # API 地址配置
│   │   ├── workspacePathEncoder.ts      # 路径编码
│   │   └── statusBar.ts                 # 状态栏
│   ├── docs/                            # 设计文档
│   ├── package.json
│   └── tsconfig.json
├── kiro-dashboard/                      # Dashboard 服务
│   ├── src/                             # Node.js 源码
│   │   ├── main.js                      # 服务入口
│   │   ├── ingest.js                    # Ingest API
│   │   ├── dashboard.js                 # Query API
│   │   ├── store.js                     # 数据库操作
│   │   ├── migrate.js                   # Schema 迁移
│   │   ├── identityCenter.js            # IAM IdC 同步
│   │   ├── sessionSync.js              # CloudTrail 同步
│   │   ├── creditSync.js               # S3 Credit 同步
│   │   └── auth.js                      # 鉴权
│   ├── public/
│   │   └── index.html                   # 前端 Dashboard 页面
│   ├── data/
│   │   └── stats.db                     # SQLite 数据库
│   ├── .env.example
│   └── package.json
├── docs/                                # 项目文档
│   ├── prototype-report.md              # 本报告
│   ├── manual-test-plan.md              # 手动测试方案
│   └── commit-stats-flow.drawio         # 流程图
└── README.md
```

### 7.6 指标计算公式汇总

| 指标 | 计算公式 |
|------|----------|
| AI 代码占比 | `ai_additions / (ai_additions + human_additions) × 100%` |
| AI 代码接受率 | `ai_accepted / total_ai_additions × 100%` |
| 插件覆盖率（单用户） | `min(activePlugins / activeSessions, 1)` |
| 总插件安装率 | `min(totalPlugins / totalSessions, 1)` |
| 删除行数守恒 | `ai_deletions + human_deletions = git_diff_deleted_lines` |

### 7.7 参考文档

| 文档 | 路径 | 说明 |
|------|------|------|
| Stats Upload API | `kiro-plugin/docs/stats-upload-api.md` | 上报接口详细定义 |
| Session Log 调查报告 | `kiro-plugin/docs/kiro-session-log-investigation-v2.md` | Execution Log 格式分析 |
| Dashboard 服务说明 | `kiro-dashboard/docs/dashboard-service-introduction.md` | 用户管理和 AWS SDK 操作 |
| 手动测试方案 | `kiro-plugin/docs/manual-test-plan.md` | 60 个测试用例 |
| Session Context V2 | `kiro-plugin/docs/session-context-v2.md` | 最新修改记录 |
