/**
 * Stats ingest API server — port 80
 * POST /api/v1/stats
 */
const http = require("node:http");
const { hasIdempotencyKey, setIdempotencyKey, saveStats, userSync } = require("./store");
const { logRequest } = require("./requestLogger");

const PORT = process.env.INGEST_PORT || 80;

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
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.user_name) {
          sendJson(res, 400, { status: "error", message: "Missing required field: user_name" });
          return;
        }
        userSync(payload);
        console.log(`[ingest] userSync: user=${payload.user_name} ip=${payload.user_ip || "?"} hostname=${payload.hostname || "?"}`);
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
