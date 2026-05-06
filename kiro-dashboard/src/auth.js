const fs = require("node:fs");
const path = require("node:path");

const TOKENS_FILE = path.resolve(__dirname, "..", "tokens.json");

let cachedTokens = null;
let lastMtime = 0;

/**
 * Load tokens from tokens.json, with simple file-mtime caching.
 */
function loadTokens() {
  try {
    const stat = fs.statSync(TOKENS_FILE);
    if (cachedTokens && stat.mtimeMs === lastMtime) {
      return cachedTokens;
    }
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8"));
    cachedTokens = new Set(data.tokens || []);
    lastMtime = stat.mtimeMs;
    return cachedTokens;
  } catch (err) {
    console.error(`[auth] Failed to load tokens: ${err.message}`);
    return new Set();
  }
}

/**
 * Validate a Bearer token. Returns true if valid.
 */
function validateToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.slice(7);
  const tokens = loadTokens();
  return tokens.has(token);
}

module.exports = { validateToken };
