/**
 * Stats ingest API server — port 80
 * POST /api/v1/stats
 */
const http = require("node:http");
const { hasIdempotencyKey, setIdempotencyKey, saveStats, userSync } = require("./store");
const { listIdCUsers } = require("./identityCenter");
const { logRequest } = require("./requestLogger");

const PORT = process.env.INGEST_PORT || 80;

/**
 * IdC user 列表缓存：10 分钟过期。避免每次 userSync 都调 AWS ListUsers。
 * 映射：IdC UserId → { userName, displayName }
 */
const IDC_CACHE_TTL_MS = 10 * 60 * 1000;
let idcUsersByUserId = null;
let idcCacheAt = 0;

async function getIdcUserIdMap() {
  const now = Date.now();
  if (idcUsersByUserId && now - idcCacheAt < IDC_CACHE_TTL_MS) {
    return idcUsersByUserId;
  }
  try {
    const users = await listIdCUsers();
    const map = new Map();
    for (const u of users) {
      if (u.userId && u.userName) {
        map.set(u.userId, u);
      }
    }
    idcUsersByUserId = map;
    idcCacheAt = now;
    return map;
  } catch (err) {
    console.error(`[ingest] Failed to list IdC users for userId resolution: ${err.message}`);
    // 缓存空 map，避免短时间内反复失败调用 AWS
    idcUsersByUserId = new Map();
    idcCacheAt = now;
    return idcUsersByUserId;
  }
}

/**
 * 根据插件上报的 user_id（格式 "d-<storeId>.<uuid>" 或裸 "<uuid>"）
 * 通过 IdC 查询返回 userName（email）。失败返回空串。
 */
async function resolveEmailByUserId(rawUserId) {
  if (!rawUserId) return "";
  // 如果是 "d-xxx.uuid" 格式取点后的部分作为 IdC UserId
  const uuid = rawUserId.includes(".") ? rawUserId.split(".").slice(1).join(".") : rawUserId;
  const map = await getIdcUserIdMap();
  const u = map.get(uuid);
  return u?.userName || "";
}

function timestamp() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${timestamp()}]`, ...args);
}

function logError(...args) {
  console.error(`[${timestamp()}]`, ...args);
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Idempotency-Key");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST" || (req.url !== "/api/v1/stats" && req.url !== "/api/v1/userSync")) {
    sendJson(res, 404, { status: "error", message: "Not found" });
    return;
  }

  // userSync 路由
  if (req.url === "/api/v1/userSync") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.user_name && !payload.user_id) {
          sendJson(res, 400, { status: "error", message: "Missing required field: user_name or user_id" });
          return;
        }

        // 如果 user_name 是 Unknown/空，并且提供了 user_id，
        // 用 IdC 查询真实 email 代替（客户端网络受限时的服务端兜底）
        const originalName = payload.user_name || "";
        const needsResolve = !originalName || originalName === "Unknown";
        if (needsResolve && payload.user_id) {
          const resolved = await resolveEmailByUserId(payload.user_id);
          if (resolved) {
            payload.user_name = resolved;
            console.log(`[ingest] userSync: resolved user_id=${payload.user_id} → ${resolved}`);
          } else {
            console.log(`[ingest] userSync: could not resolve user_id=${payload.user_id} via IdC, keep user_name=${originalName || "(empty)"}`);
            if (!payload.user_name) payload.user_name = "Unknown";
          }
        }

        userSync(payload);
        console.log(`[ingest] userSync: user=${payload.user_name} ip=${payload.user_ip || "?"} hostname=${payload.hostname || "?"} user_id=${payload.user_id || "?"}`);
        sendJson(res, 200, { status: "ok" });
      } catch (err) {
        console.error(`[ingest] userSync error: ${err.message}`);
        sendJson(res, 500, { status: "error", message: err.message });
      }
    });
    return;
  }

  // Idempotency check
  const idempotencyKey = req.headers["x-idempotency-key"];
  if (idempotencyKey && hasIdempotencyKey(idempotencyKey)) {
    log(`[ingest] Duplicate request (idempotency key: ${idempotencyKey})`);
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // Read body
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    // Limit body size to 10MB
    if (body.length > 10 * 1024 * 1024) {
      sendJson(res, 413, { status: "error", message: "Payload too large" });
      req.destroy();
    }
  });

  req.on("end", () => {
    try {
      const payload = JSON.parse(body);

      if (!payload.repo_name || !payload.commit_sha) {
        sendJson(res, 400, { status: "error", message: "Missing required fields: repo_name, commit_sha" });
        return;
      }

      log(`[ingest] Received request body:\n${JSON.stringify(payload, null, 2)}`);

      // Write request payload to daily log file
      logRequest(payload, {
        method: req.method,
        url: req.url,
        remoteAddress: req.socket?.remoteAddress,
        idempotencyKey: idempotencyKey || undefined,
      });

      saveStats(payload);

      if (idempotencyKey) {
        setIdempotencyKey(idempotencyKey);
      }

      log(
        `[ingest] Saved commit stats: repo=${payload.repo_name} branch=${payload.branch} ` +
        `commit=${payload.commit_sha?.slice(0, 8)} user=${payload.user_name}`
      );

      sendJson(res, 200, { status: "ok" });
    } catch (err) {
      logError(`[ingest] Bad request: ${err.message}`);
      sendJson(res, 400, { status: "error", message: "Invalid JSON" });
    }
  });
});

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

server.listen(PORT, () => {
  log(`[ingest] Stats ingest API listening on port ${PORT}`);
});
