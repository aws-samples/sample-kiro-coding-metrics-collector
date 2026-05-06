/**
 * 从 Kiro 官方 S3 User Activity Report 中读取 credit 用量，
 * 每小时同步一次到本地 SQLite kiro-user 表。
 *
 * S3 路径格式（新版）:
 *   s3://<bucket>/<prefix>/AWSLogs/<accountId>/KiroLogs/by_user_analytic/<region>/<year>/<month>/<day>/00/<accountId>_by_user_analytic_<timestamp>.csv
 *
 * CSV 字段（新版）:
 *   Date, UserId, Client_Type, Subscription_Tier, ProfileId,
 *   Total_messages, Chat_Conversations, Credits_Used,
 *   Overage_Enabled, Overage_Cap, Overage_Credits_Used
 *
 * 旧版路径:
 *   s3://<bucket>/<prefix>/AWSLogs/<accountId>/KiroLogs/user_report/<region>/<year>/<month>/<day>/00/<clientType>_<accountId>_user_report_<timestamp>.csv
 */
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { userSync, syncIdCUsersToLocal } = require("./store");
const { listIdCUsers } = require("./identityCenter");

const REGION = process.env.AWS_REGION;
const S3_BUCKET = process.env.KIRO_S3_BUCKET;
const S3_PREFIX = process.env.KIRO_S3_PREFIX;
const ACCOUNT_ID = process.env.KIRO_ACCOUNT_ID;
const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 小时

const s3 = new S3Client({ region: REGION });

// 记录已处理的 S3 key，避免重复处理
const processedKeys = new Set();

/**
 * 启动定时同步
 */
function startCreditSync() {
  console.log(`[creditSync] Starting S3 credit sync (bucket=${S3_BUCKET}, prefix=${S3_PREFIX}, interval=1h)`);
  // 启动时立即执行一次
  syncCreditsFromS3().catch((err) => console.error(`[creditSync] Initial sync failed: ${err.message}`));
  // 每小时执行
  setInterval(() => {
    syncCreditsFromS3().catch((err) => console.error(`[creditSync] Sync failed: ${err.message}`));
  }, SYNC_INTERVAL_MS);
}

/**
 * 从 S3 读取最近 30 天的 CSV 报告，更新 credit 用量。
 * CSV 中的 UserId 格式为 "d-xxx.userId"，需要通过 Identity Center 反查 UserName（email）。
 */
async function syncCreditsFromS3() {
  console.log("[creditSync] Syncing credits from S3...");

  // 构建 userId → userName 映射表，同时同步到本地用户表
  let userIdMap = {};
  try {
    const idcUsers = await listIdCUsers();
    syncIdCUsersToLocal(idcUsers);
    for (const u of idcUsers) {
      if (u.userId && u.userName) {
        userIdMap[u.userId] = u.userName;
      }
    }
    console.log(`[creditSync] Loaded ${Object.keys(userIdMap).length} IdC user(s) for mapping`);
  } catch (err) {
    console.error(`[creditSync] Failed to load IdC users: ${err.message}`);
    // 继续执行，只是无法解析 userId
  }

  const prefixes = buildDatePrefixes(30);
  let totalFiles = 0;
  let totalUsers = 0;

  for (const prefix of prefixes) {
    const keys = await listCsvFiles(prefix);
    for (const key of keys) {
      if (processedKeys.has(key)) { continue; }
      try {
        const records = await downloadAndParseCsv(key);
        for (const record of records) {
          // 将 CSV 中的 UserId 解析为 UserName
          const userName = resolveUserName(record.rawUserId, userIdMap);
          if (userName && record.creditsUsed > 0) {
            const date = record.date || new Date().toISOString().slice(0, 10);
            userSync({
              user_name: userName,
              user_ip: "",
              credit_used: { [date]: record.creditsUsed },
              _overwrite_credits: true,
            });
            totalUsers++;
          }
        }
        processedKeys.add(key);
        totalFiles++;
      } catch (err) {
        console.error(`[creditSync] Failed to process ${key}: ${err.message}`);
      }
    }
  }

  console.log(`[creditSync] Sync complete: ${totalFiles} file(s), ${totalUsers} user record(s) updated`);
}

/**
 * 将 CSV 中的 UserId 解析为 UserName（email）。
 * UserId 格式: "d-906602fc05.04b8b4f8-0071-7044-fe9c-ff2bcb4fa5b3"
 * 提取 "." 后面的部分作为 Identity Store UserId，然后查映射表。
 * 如果 UserId 本身就是 email 格式（包含 @），直接返回。
 */
function resolveUserName(rawUserId, userIdMap) {
  if (!rawUserId) { return ""; }

  // 如果已经是 email 格式，直接返回
  if (rawUserId.includes("@")) { return rawUserId; }

  // 提取 "." 后面的 userId 部分
  const dotIdx = rawUserId.indexOf(".");
  const userId = dotIdx >= 0 ? rawUserId.slice(dotIdx + 1) : rawUserId;

  // 查映射表
  const userName = userIdMap[userId];
  if (userName) {
    return userName;
  }

  console.warn(`[creditSync] Cannot resolve UserId: ${rawUserId} (userId=${userId} not found in IdC)`);
  return rawUserId; // 无法解析时返回原始值
}

/**
 * 构建最近 N 天的 S3 前缀列表
 * 同时覆盖新版 (by_user_analytic) 和旧版 (user_report) 路径
 */
function buildDatePrefixes(days) {
  const prefixes = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    // 新版路径
    prefixes.push(`${S3_PREFIX}AWSLogs/${ACCOUNT_ID}/KiroLogs/by_user_analytic/${REGION}/${year}/${month}/${day}/`);
    // 旧版路径
    prefixes.push(`${S3_PREFIX}AWSLogs/${ACCOUNT_ID}/KiroLogs/user_report/${REGION}/${year}/${month}/${day}/`);
  }
  return prefixes;
}

/**
 * 列出指定前缀下的所有 CSV 文件
 */
async function listCsvFiles(prefix) {
  try {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
    }));
    return (resp.Contents || [])
      .map((obj) => obj.Key)
      .filter((key) => key && key.endsWith(".csv"));
  } catch {
    return [];
  }
}

/**
 * 下载并解析 CSV 文件
 * 返回: [{ userName, date, creditsUsed, clientType, tier }]
 */
async function downloadAndParseCsv(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const body = await streamToString(resp.Body);
  return parseCsv(body, key);
}

function parseCsv(csvText, key) {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) { return []; }

  const headers = lines[0].split(",").map((h) => h.trim());
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ""; });

    const rawUserId = row.UserId || row.userId || "";
    const date = row.Date || row.date || extractDateFromKey(key);
    const creditsUsed = parseFloat(row.Credits_Used || row.credits_used || "0") || 0;

    if (rawUserId) {
      records.push({
        rawUserId,
        date,
        creditsUsed,
        clientType: row.Client_Type || "",
        tier: row.Subscription_Tier || "",
      });
    }
  }

  console.log(`[creditSync] Parsed ${key}: ${records.length} record(s)`);
  return records;
}

/** 从 S3 key 中提取日期 (yyyy/mm/dd → yyyy-mm-dd) */
function extractDateFromKey(key) {
  const match = key.match(/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (match) { return `${match[1]}-${match[2]}-${match[3]}`; }
  return new Date().toISOString().slice(0, 10);
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

module.exports = { startCreditSync, syncCreditsFromS3 };
