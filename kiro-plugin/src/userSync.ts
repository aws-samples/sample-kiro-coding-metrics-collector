import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import * as http from "node:http";
import * as vscode from "vscode";

import { USER_SYNC_URL } from "./apiConfig";
import { QClientLogWatcher } from "./qClientWatcher";

const REQUEST_TIMEOUT_MS = 10_000;
/** userSync 间隔：距离上一次 userSync 超过这个时间才重新上报 */
const SYNC_GAP_MS = 4 * 60 * 60 * 1000; // 4 小时
/** 调试日志保留天数 */
const LOG_RETENTION_DAYS = 15;
/** 无法获取 email 时使用的占位符 */
const UNKNOWN_EMAIL = "Unknown";

interface UserSyncPayload {
  user_name: string;
  user_ip: string;
  hostname: string;
  user_id?: string;
}

let watcher: QClientLogWatcher | null = null;
let inflight = false;
/** 插件启动后是否从未 userSync 过，首次触发时为 true */
let isFirst = true;

/**
 * 插件启动时调用：
 *   只监控 q-client.log，等待 Kiro 调用 GetUsageLimitsCommand 时再评估是否上报。
 *
 * userSync 的上报时机只有两个，都必须先由 q-client.log 中的 GetUsageLimitsCommand 事件触发，
 * 再经过判断决定是否真正上报：
 *   1. 插件本次启动后第一次被触发（isFirst=true）
 *   2. 距离上次 userSync 超过 4 小时
 */
export function reportUserLogin(): void {
  if (watcher) return;
  isFirst = true;
  watcher = new QClientLogWatcher((info) => maybeDoUserSync(info.userId));
  watcher.start();
  console.log("[git-ai-kiro] userSync: waiting for GetUsageLimitsCommand trigger");
}

/**
 * 停止监控（插件 deactivate 时调用）
 */
export function stopUserSync(): void {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
  isFirst = true;
}

/**
 * 被 q-client.log 中的 GetUsageLimitsCommand 事件触发后调用。
 * @param userId 从 q-client.log 中解析到的用户 userId（可能为空）
 */
async function maybeDoUserSync(userId: string): Promise<void> {
  if (inflight) {
    console.log(`[git-ai-kiro] userSync: already in progress, skip`);
    return;
  }
  inflight = true;
  try {
    if (isFirst) {
      console.log(`[git-ai-kiro] userSync: first trigger after extension start, uploading`);
    } else {
      const lastTs = getLastUserSyncTimestamp();
      if (lastTs === null) {
        console.log(`[git-ai-kiro] userSync: no previous userSync record found, uploading`);
      } else {
        const ageMs = Date.now() - lastTs;
        if (ageMs < SYNC_GAP_MS) {
          const ageMin = Math.floor(ageMs / 1000 / 60);
          const remainMin = Math.floor((SYNC_GAP_MS - ageMs) / 1000 / 60);
          console.log(`[git-ai-kiro] userSync: last sync ${ageMin}min ago, skip until ${remainMin}min later`);
          return;
        }
        console.log(`[git-ai-kiro] userSync: last sync ${Math.floor(ageMs / 1000 / 60)}min ago, uploading`);
      }
    }

    await doUserSync(userId);
    isFirst = false;
  } finally {
    inflight = false;
  }
}

/**
 * 执行一次 userSync 上报。
 *
 * email 获取策略（精简后只有一条路径 + Unknown 兜底）：
 *   1. 尝试 kiro-cli whoami
 *   2. 失败则上报 Unknown + user_id，由 dashboard 端用 AWS SDK 解析
 *
 * user_id 规则：q-client.log 中的 userId 是 "d-<storeId>.<uuid>" 格式，
 * 但 d-<storeId> 是 IAM Identity Store 的标识，对业务侧无用且属于敏感信息，
 * 这里只上传点号后的 uuid 部分。dashboard 侧直接用该 uuid 匹配 IdC UserId。
 */
async function doUserSync(userId: string): Promise<void> {
  const email = getEmailFromKiroCli();
  const effectiveEmail = email || UNKNOWN_EMAIL;
  const ip = getUserIp();
  const hn = os.hostname();

  const cleanUserId = stripIdentityStorePrefix(userId);

  const payload: UserSyncPayload = {
    user_name: effectiveEmail,
    user_ip: ip,
    hostname: hn,
  };
  if (cleanUserId) payload.user_id = cleanUserId;
  console.log(`[git-ai-kiro] userSync payload: ${JSON.stringify(payload)} → ${USER_SYNC_URL}`);

  writeDebugLog(payload);

  try {
    const status = await doPost(USER_SYNC_URL, "", JSON.stringify(payload));
    console.log(`[git-ai-kiro] userSync: ${effectiveEmail} ip=${ip} hostname=${hn} user_id=${cleanUserId || "(none)"} HTTP ${status}`);
  } catch (err) {
    console.warn(`[git-ai-kiro] userSync failed: ${err}`);
  }
}

/**
 * 去掉 q-client userId 里的 "d-<storeId>." 前缀，只保留 IdC UserId (UUID)。
 * 已经是裸 UUID 的输入原样返回。
 */
function stripIdentityStorePrefix(raw: string): string {
  if (!raw) return "";
  const dotIdx = raw.indexOf(".");
  if (dotIdx < 0) return raw;
  // 只有形如 "d-<storeId>.<rest>" 的前缀需要剥离
  const prefix = raw.slice(0, dotIdx);
  if (/^d-[a-zA-Z0-9]+$/.test(prefix)) {
    return raw.slice(dotIdx + 1);
  }
  return raw;
}

/**
 * 尝试通过 kiro-cli whoami 获取 email。失败或没配置返回空字符串。
 */
function getEmailFromKiroCli(): string {
  try {
    const output = execFileSync("kiro-cli", ["whoami"], {
      timeout: 10_000, encoding: "utf-8",
    });
    const match = output.match(/Email:\s*(\S+)/i);
    if (match) {
      console.log(`[git-ai-kiro] Got email from kiro-cli whoami: ${match[1]}`);
      return match[1];
    }
    console.log("[git-ai-kiro] kiro-cli whoami succeeded but no email found in output");
  } catch (err) {
    console.log(`[git-ai-kiro] kiro-cli whoami not available: ${err}`);
  }
  return "";
}

/** 向工作区的 git repo 的 .git/ai/last_upload_payload.json 追加一条 userSync 记录 */
function writeDebugLog(payload: UserSyncPayload): void {
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;
    const { findGitRoot, findGitReposInDir } = require("./gitUtils");
    const wsPath = folders[0].uri.fsPath;
    const repos: string[] = [];
    const gitRoot = findGitRoot(wsPath);
    if (gitRoot) {
      repos.push(gitRoot);
    } else {
      repos.push(...findGitReposInDir(wsPath));
    }
    for (const repoPath of repos) {
      const aiDir = path.join(repoPath, ".git", "ai");
      if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir, { recursive: true });
      const logFile = path.join(aiDir, "last_upload_payload.json");
      fs.appendFileSync(logFile, `[userSync] [${new Date().toISOString()}] ${JSON.stringify(payload)}\n`, "utf-8");
      cleanOldLines(logFile, LOG_RETENTION_DAYS);
    }
  } catch { /* best effort */ }
}

/**
 * 扫描工作区的 git repo 的 last_upload_payload.json，返回最近一次 userSync 的时间戳（ms）。
 * 没有记录返回 null。
 */
function getLastUserSyncTimestamp(): number | null {
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return null;
    const { findGitRoot, findGitReposInDir } = require("./gitUtils");
    const wsPath = folders[0].uri.fsPath;
    const repos: string[] = [];
    const gitRoot = findGitRoot(wsPath);
    if (gitRoot) {
      repos.push(gitRoot);
    } else {
      repos.push(...findGitReposInDir(wsPath));
    }

    let latest: number | null = null;
    for (const repoPath of repos) {
      const logFile = path.join(repoPath, ".git", "ai", "last_upload_payload.json");
      if (!fs.existsSync(logFile)) continue;
      let content = "";
      try { content = fs.readFileSync(logFile, "utf-8"); } catch { continue; }
      // 用正则直接匹配所有 [userSync] [ISO时间戳] 片段，不依赖行边界
      // （Windows 上可能因换行符/BOM 问题导致多条记录粘连在同一行，此写法更鲁棒）
      const re = /\[userSync\]\s*\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const t = new Date(match[1]).getTime();
        if (!isNaN(t) && (latest === null || t > latest)) {
          latest = t;
        }
      }
    }
    return latest;
  } catch {
    return null;
  }
}

// ==================== 获取本机 IP ====================

function getUserIp(): string {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (!iface.internal && iface.family === "IPv4" && iface.address) {
          return iface.address;
        }
      }
    }
  } catch {}
  return "";
}

// ==================== HTTP POST ====================

function doPost(url: string, token: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (token) { headers.Authorization = `Bearer ${token}`; }
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      method: "POST",
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// ==================== 日志清理 ====================

/** 清理日志文件中超过指定天数的行 */
function cleanOldLines(filePath: string, days: number): void {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    // 兼容 \r\n / \r / \n 三种换行
    const lines = content.split(/\r\n|\r|\n/);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const kept = lines.filter((line) => {
      if (!line.trim()) return false;
      const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
      if (!match) return true;
      const ts = new Date(match[1]).getTime();
      return !isNaN(ts) && ts >= cutoff;
    });
    fs.writeFileSync(filePath, kept.join("\n") + "\n", "utf-8");
  } catch { /* best effort */ }
}
