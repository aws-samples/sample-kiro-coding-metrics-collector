/**
 * 轻量 .env 文件加载器 — 无外部依赖。
 *
 * 规则：
 *  - 逐行解析 KEY=VALUE
 *  - 忽略空行和 # 开头的注释
 *  - 支持双引号 / 单引号包裹的值（会去掉引号）
 *  - 已存在的环境变量优先，不会被 .env 覆盖
 */

const fs = require("fs");
const path = require("path");

function loadEnv(envPath) {
  const filePath = envPath || path.resolve(process.cwd(), ".env");

  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf-8");

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const idx = line.indexOf("=");
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    // 去掉首尾匹配的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // 已有的环境变量优先，不覆盖
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  console.log(`[env] Loaded .env from ${filePath}`);
}

module.exports = { loadEnv };
