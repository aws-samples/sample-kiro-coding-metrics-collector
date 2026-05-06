/**
 * Dashboard server — port 3500
 * Serves the web UI and query APIs.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { getAllReposSummary, getRepoStats, aggregateRepoStats, getAiRatioHistory, getAllUsers, syncIdCUsersToLocal, countSessionsByUserId, countPluginsByUserName, getTotalSessionCount, getTotalPluginCount } = require("./store");
const { listIdCUsers } = require("./identityCenter");

const PORT = process.env.DASHBOARD_PORT || 3500;
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");

  // API routes
  if (req.url === "/api/repos" && req.method === "GET") {
    const summary = getAllReposSummary();
    sendJson(res, 200, summary);
    return;
  }

  // 用户表格 API：先同步 IdC 用户到本地表，再从本地表读取
  if (req.url === "/api/users" && req.method === "GET") {
    try {
      // 从 IAM Identity Center 获取用户列表，同步到本地表（只插入新用户）
      const idcUsers = await listIdCUsers();
      syncIdCUsersToLocal(idcUsers);

      // 从本地表读取所有用户（已包含 plugin_added、credit_used 等）
      const users = getAllUsers();

      // 构建 IdC displayName/status/userId 查找表
      const idcMap = {};
      for (const u of idcUsers) { idcMap[u.userName] = u; }

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const result = users.map((u) => {
        const idc = idcMap[u.user_name] || {};
        const creditUsed = u.credit_used || {};
        const totalCredits = Object.entries(creditUsed)
          .filter(([date]) => date >= cutoffStr)
          .reduce((sum, [, v]) => sum + (typeof v === "number" ? v : 0), 0);

        // 通过 user_id 查询活跃 session 数
        const userId = idc.userId || u.user_id || "";
        const activeSessions = userId ? countSessionsByUserId(userId) : 0;

        // 通过 user_name 查询活跃插件数
        const activePlugins = countPluginsByUserName(u.user_name);

        // 插件覆盖率 = 活跃插件数 / 活跃 session 数
        const pluginCoverage = activeSessions > 0 ? Math.min(activePlugins / activeSessions, 1) : 0;

        return {
          userName: u.user_name,
          displayName: idc.displayName || "",
          status: idc.status || "UNKNOWN",
          activeSessions,
          activePlugins,
          pluginCoverage: Math.round(pluginCoverage * 1000) / 1000,
          totalCredits: Math.round(totalCredits * 100) / 100,
          creditUsed,
          updatedAt: u.updated_at || "",
        };
      });

      // 汇总信息：总插件安装率 = plugins 表行数 / sessions 表行数
      const totalPlugins = getTotalPluginCount();
      const totalSessions = getTotalSessionCount();
      const totalPluginRate = totalSessions > 0 ? Math.min(totalPlugins / totalSessions, 1) : 0;

      sendJson(res, 200, {
        users: result,
        summary: {
          totalUsers: users.length,
          totalPlugins,
          totalSessions,
          totalPluginRate: Math.round(totalPluginRate * 1000) / 1000,
        },
      });
    } catch (err) {
      console.error(`[dashboard] /api/users error: ${err.message}`);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.url?.startsWith("/api/repos/") && req.method === "GET") {
    const repoName = decodeURIComponent(req.url.slice("/api/repos/".length));

    // /api/repos/<name>/ai-ratio-history — AI ratio history
    if (repoName.endsWith("/ai-ratio-history")) {
      const name = repoName.slice(0, -"/ai-ratio-history".length);
      const history = getAiRatioHistory(name);
      sendJson(res, 200, history);
      return;
    }

    // /api/repos/<name>/aggregate — aggregated summary
    if (repoName.endsWith("/aggregate")) {
      const name = repoName.slice(0, -"/aggregate".length);
      const agg = aggregateRepoStats(name);
      if (!agg) {
        sendJson(res, 404, { error: "Repo not found" });
      } else {
        sendJson(res, 200, agg);
      }
      return;
    }

    // /api/repos/<name> — raw checkpoint records
    const stats = getRepoStats(repoName);
    if (stats.length === 0) {
      sendJson(res, 404, { error: "Repo not found" });
    } else {
      sendJson(res, 200, stats);
    }
    return;
  }

  // Static files
  let filePath = req.url === "/" ? "/index.html" : req.url;
  const fullPath = path.join(PUBLIC_DIR, filePath);

  // Prevent directory traversal
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(fullPath);
  const mimeTypes = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
  };

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
    res.end(data);
  });
});

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

server.listen(PORT, () => {
  console.log(`[dashboard] Dashboard listening on http://localhost:${PORT}`);
});
