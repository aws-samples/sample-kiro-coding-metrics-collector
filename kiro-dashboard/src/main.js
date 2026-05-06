/**
 * Main entry — 加载 .env → 环境变量检查 → 启动 ingest + dashboard + S3 credit sync + session sync
 */
const { loadEnv } = require("./loadEnv");
loadEnv(); // 优先读取工作目录下的 .env，已有环境变量不会被覆盖

const { checkEnv } = require("./envCheck");
checkEnv();

require("./ingest");
require("./dashboard");

const { startCreditSync } = require("./creditSync");
startCreditSync();

const { startSessionSync } = require("./sessionSync");
startSessionSync();
