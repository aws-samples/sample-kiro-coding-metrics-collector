/**
 * CloudTrail Session 同步模块
 * 从 CloudTrail 获取 CreateToken 事件，解析 SSO session 信息，写入 sessions 表。
 * - 首次启动：获取近 30 天的 session
 * - 此后每天定时获取前 24 小时的 session，并清理过期记录
 */
const { CloudTrailClient, LookupEventsCommand } = require("@aws-sdk/client-cloudtrail");
const { upsertSessions, deleteExpiredSessions } = require("./store");

const REGION = process.env.AWS_REGION || "us-east-1";
const client = new CloudTrailClient({ region: REGION });

// 每天执行一次（毫秒）
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 从 CloudTrail 查询 CreateToken 事件，解析 session 信息
 * @param {Date} startTime 查询起始时间
 * @param {Date} endTime 查询结束时间
 * @returns {Array<{session_id, user_id, expire_time}>}
 */
async function fetchSessionsFromCloudTrail(startTime, endTime) {
  const sessions = [];
  let nextToken;

  do {
    const resp = await client.send(new LookupEventsCommand({
      LookupAttributes: [{ AttributeKey: "EventName", AttributeValue: "CreateToken" }],
      StartTime: startTime,
      EndTime: endTime,
      MaxResults: 50,
      ...(nextToken ? { NextToken: nextToken } : {}),
    }));

    for (const event of resp.Events || []) {
      try {
        const detail = JSON.parse(event.CloudTrailEvent || "{}");
        const sessionId = detail?.responseElements?.aws_sso_app_session_id;
        // onBehalfOf 在 userIdentity 下，可能是对象或数组
        const onBehalfOf = detail?.userIdentity?.onBehalfOf;
        const userId = Array.isArray(onBehalfOf) ? onBehalfOf[0]?.userId : onBehalfOf?.userId;
        const expireTime = detail?.additionalEventData?.["identitycenter:SessionNotOnOrAfter"];

        if (sessionId && userId && expireTime) {
          sessions.push({ session_id: sessionId, user_id: userId, expire_time: expireTime });
        }
      } catch {
        // 解析失败，跳过
      }
    }

    nextToken = resp.NextToken;
  } while (nextToken);

  return sessions;
}

/**
 * 同步 session 数据：查询 CloudTrail → upsert 到 sessions 表 → 删除过期记录
 */
async function syncSessions(daysBack) {
  const endTime = new Date();
  const startTime = new Date();
  startTime.setDate(startTime.getDate() - daysBack);

  console.log(`[sessionSync] Fetching CreateToken events from ${startTime.toISOString()} to ${endTime.toISOString()}`);

  try {
    const sessions = await fetchSessionsFromCloudTrail(startTime, endTime);
    console.log(`[sessionSync] Found ${sessions.length} session(s) from CloudTrail`);

    if (sessions.length > 0) {
      upsertSessions(sessions);
      console.log(`[sessionSync] Upserted ${sessions.length} session(s) to DB`);
    }

    const deleted = deleteExpiredSessions();
    if (deleted > 0) {
      console.log(`[sessionSync] Deleted ${deleted} expired session(s)`);
    }
  } catch (err) {
    console.error(`[sessionSync] Failed to sync sessions: ${err.message}`);
  }
}

/**
 * 启动 session 同步：
 * 1. 首次启动获取近 30 天数据
 * 2. 此后每 24 小时获取前 1 天数据
 */
function startSessionSync() {
  // 首次启动：获取近 30 天
  syncSessions(30);

  // 每天定时：获取前 1 天
  setInterval(() => {
    syncSessions(1);
  }, DAILY_INTERVAL_MS);

  console.log("[sessionSync] Session sync started (initial: 30d, interval: 24h)");
}

module.exports = { startSessionSync, syncSessions };
