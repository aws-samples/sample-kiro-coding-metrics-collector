# git-ai Dashboard

git-ai 统计数据的接收服务和可视化控制面板。配合 [git-ai for Kiro](../kiro/) 插件使用，接收插件自动上报的 AI 代码归属统计数据，并提供 Web 页面展示各仓库的 AI 代码占比、工具模型细分、归属覆盖情况等。

## 架构

```
Kiro 插件 (checkpoint 成功后)
  │
  │  POST /api/v1/stats
  ▼
Ingest 服务 (端口 80)
  │  Token 验证 → 幂等去重 → 写入文件
  ▼
data/ 目录 (按仓库名分目录存储 JSON)
  ▲
  │  GET /api/repos, GET /api/repos/:name
  │
Dashboard 服务 (端口 3500)
  │
  ▼
Web 页面 (浏览器)
```

两个服务独立运行：
- **Ingest 服务** — 端口 80，接收插件上报的统计数据
- **Dashboard 服务** — 端口 3500，提供 Web 页面和查询 API

## 快速开始

```bash
cd agent-support/kiro-dashboard

# 同时启动两个服务（端口 80 需要 sudo）
sudo node src/main.js

# 或分别启动
sudo node src/ingest.js          # 数据上传接口
node src/dashboard.js             # Dashboard 页面
```

启动后访问 http://localhost:3500 查看 Dashboard。

### 使用自定义端口

端口 80 需要 root 权限，本地开发时可以用环境变量覆盖：

```bash
INGEST_PORT=8080 DASHBOARD_PORT=3500 node src/main.js
```

对应地，Kiro 插件的 `gitai.kiro.statsUploadUrl` 配置为 `http://localhost:8080/api/v1/stats`。

## 配置

### Token 管理

编辑 `tokens.json` 添加或移除有效 token：

```json
{
  "tokens": [
    "test-token-123",
    "your-production-token"
  ]
}
```

文件修改后自动生效，无需重启服务。

### Kiro 插件配置

在 Kiro 的 `settings.json` 中配置：

```json
{
  "gitai.kiro.statsUploadUrl": "http://your-server/api/v1/stats",
  "gitai.kiro.statsUploadToken": "test-token-123"
}
```

## API

### 数据上传

```
POST /api/v1/stats  (Ingest 服务)
```

Headers:
- `Authorization: Bearer <token>`
- `X-Idempotency-Key: <sha256-hash>` — 幂等 key，相同 key 的重复请求不会重复写入

详细的请求/响应格式见 [stats-upload-api.md](../kiro/docs/stats-upload-api.md)。

### Dashboard 查询

```
GET /api/repos              — 所有仓库的摘要列表
GET /api/repos/:repo_name   — 指定仓库的完整上报历史
```

## 数据存储

统计数据以 JSON 文件形式存储在 `data/` 目录下，按仓库名分目录：

```
data/
├── dummy-project3/
│   ├── 2026-04-08T12-00-00Z_6e7f6f94.json
│   └── 2026-04-08T13-30-00Z_a1b2c3d4.json
├── git-ai/
│   └── ...
└── .idempotency/           # 幂等 key 记录
    └── <key-hash>
```

## 测试

```bash
# 启动服务
INGEST_PORT=8080 node src/main.js &

# 上传测试数据
curl -X POST http://localhost:8080/api/v1/stats \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token-123" \
  -H "X-Idempotency-Key: test-001" \
  -d '{
    "repo_name": "test-repo",
    "head_commit": "abc12345",
    "branch": "main",
    "reported_at": "2026-04-08T12:00:00Z",
    "range_stats": {
      "human_additions": 100,
      "ai_additions": 200,
      "mixed_additions": 10
    }
  }'

# 查看 Dashboard
open http://localhost:3500
```

## 依赖

零外部依赖，仅使用 Node.js 内置模块。要求 Node.js >= 20。
