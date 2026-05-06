/**
 * Request logger — writes incoming stats request payloads to daily log files.
 * Log files are stored in <cwd>/logs/ with the naming pattern: stats-YYYY-MM-DD.log
 */
const fs = require("node:fs");
const path = require("node:path");

const LOGS_DIR = path.join(process.cwd(), "logs");

/**
 * Ensure the logs directory exists (created once on startup).
 */
function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Returns today's date string in YYYY-MM-DD format (local time).
 */
function todayDateStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Build the log file path for a given date string.
 */
function logFilePath(dateStr) {
  return path.join(LOGS_DIR, `stats-${dateStr}.log`);
}

/**
 * Append a request payload to today's log file.
 * Each entry is a single line of JSON prefixed with a timestamp.
 *
 * @param {object} payload - The parsed request body
 * @param {object} [meta] - Optional metadata (method, url, idempotencyKey, remoteAddress)
 */
function logRequest(payload, meta = {}) {
  try {
    ensureLogsDir();

    const entry = {
      timestamp: new Date().toISOString(),
      ...(meta.method && { method: meta.method }),
      ...(meta.url && { url: meta.url }),
      ...(meta.remoteAddress && { remoteAddress: meta.remoteAddress }),
      ...(meta.idempotencyKey && { idempotencyKey: meta.idempotencyKey }),
      payload,
    };

    const line = JSON.stringify(entry) + "\n";
    const filePath = logFilePath(todayDateStr());

    fs.appendFileSync(filePath, line, "utf-8");
  } catch (err) {
    // Don't let logging failures break the ingest pipeline
    console.error(`[${new Date().toISOString()}] [requestLogger] Failed to write log: ${err.message}`);
  }
}

module.exports = { logRequest, logFilePath, ensureLogsDir, LOGS_DIR };
