import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import * as http from "node:http";
import * as vscode from "vscode";

import { USER_SYNC_URL } from "./apiConfig";

const REQUEST_TIMEOUT_MS = 10_000;
// 每 4 小时定时上报间隔（毫秒）
const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface UserSyncPayload {
  user_name: string;
  user_ip: string;
  hostname: string;
}

let cachedEmail = "";
let cachedIp = "";
let syncTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 插件启动时调用：获取用户 email、IP、Mac 地址，上报到 dashboard。
 * 首次立即上报，此后每小时定时上报。
 */
export async function reportUserLogin(): Promise<void> {
  // 首次立即上报
  await doUserSync();

  // 每小时定时上报
  syncTimer = setInterval(() => {
    doUserSync().catch((err) => {
      console.warn(`[git-ai-kiro] userSync periodic failed: ${err}`);
    });
  }, SYNC_INTERVAL_MS);
  console.log("[git-ai-kiro] userSync: scheduled every 4 hours");
}

/**
 * 停止定时上报（插件 deactivate 时调用）
 */
export function stopUserSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

/**
 * 执行一次 userSync 上报
 */
async function doUserSync(): Promise<void> {
  const email = await getUserEmail();
  const ip = getUserIp();
  const hn = os.hostname();
  if (!email) {
    console.log("[git-ai-kiro] userSync: cannot get user email, skipping");
    return;
  }

  cachedEmail = email;
  cachedIp = ip;

  const payload: UserSyncPayload = { user_name: email, user_ip: ip, hostname: hn };
  console.log(`[git-ai-kiro] userSync payload: ${JSON.stringify(payload)} → ${USER_SYNC_URL}`);

  // 追加到调试文件（所有发现的 git repo）
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
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
        // 追加带时间戳的记录
        fs.appendFileSync(logFile, `[userSync] [${new Date().toISOString()}] ${JSON.stringify(payload)}\n`, "utf-8");
        // 清理 15 天前的行
        cleanOldLines(logFile, 15);
      }
    }
  } catch { /* best effort */ }

  try {
    const status = await doPost(USER_SYNC_URL, "", JSON.stringify(payload));
    console.log(`[git-ai-kiro] userSync: ${email} ip=${ip} hostname=${hn} HTTP ${status}`);
  } catch (err) {
    console.warn(`[git-ai-kiro] userSync failed: ${err}`);
  }
}

// Credit 用量改由 dashboard 服务端从 S3 官方报告同步，插件不再上报

// ==================== 获取用户 email ====================

/**
 * 三级 fallback 获取用户 email：
 * 1. kiro-cli whoami — 最可靠，直接从 Kiro 认证系统获取
 * 2. getUsageLimits API — 读取本地 SSO token + profile，调用 AWS API
 * 3. git config user.email — 最后兜底，从 git 配置获取
 */
async function getUserEmail(): Promise<string> {
  // 方式 1: kiro-cli whoami
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
    console.warn(`[git-ai-kiro] kiro-cli whoami failed (not installed or error): ${err}`);
  }

  // 方式 2: getUsageLimits API
  try {
    const email = await getEmailFromUsageLimits();
    if (email) {
      console.log(`[git-ai-kiro] Got email from getUsageLimits API: ${email}`);
      return email;
    }
    console.log("[git-ai-kiro] getUsageLimits API succeeded but no email in response");
  } catch (err) {
    console.warn(`[git-ai-kiro] getUsageLimits API failed (token invalid or network error): ${err}`);
  }

  // 方式 3: git config user.email
  try {
    const folders = vscode.workspace.workspaceFolders;
    const cwd = folders?.[0]?.uri.fsPath;
    if (cwd) {
      const email = execFileSync("git", ["config", "user.email"], {
        cwd, timeout: 5_000, encoding: "utf-8",
      }).trim();
      if (email) {
        console.log(`[git-ai-kiro] Got email from git config: ${email}`);
        return email;
      }
    }
  } catch (err) {
    console.warn(`[git-ai-kiro] git config user.email failed: ${err}`);
  }

  console.warn("[git-ai-kiro] All 3 methods to get user email failed");
  return "";
}

async function getEmailFromUsageLimits(): Promise<string> {
  const tokenData = readJsonFile(getSsoTokenPath());
  if (!tokenData?.accessToken) {
    console.log("[git-ai-kiro] No SSO access token found");
    return "";
  }

  const profileData = readJsonFile(getProfileJsonPath());
  if (!profileData?.arn) {
    console.log("[git-ai-kiro] No profile ARN found");
    return "";
  }

  const region = tokenData.region || "us-east-1";
  const profileArn = encodeURIComponent(profileData.arn);
  const apiPath = `/getUsageLimits?profileArn=${profileArn}&origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true`;

  return new Promise((resolve) => {
    const req = https.request({
      hostname: `codewhisperer.${region}.amazonaws.com`,
      path: apiPath,
      method: "GET",
      headers: { Authorization: `Bearer ${tokenData.accessToken}` },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.userInfo?.email || "");
        } catch {
          resolve("");
        }
      });
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.end();
  });
}

// ==================== 本地文件路径 ====================

function getSsoTokenPath(): string {
  return path.join(os.homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");
}

function getProfileJsonPath(): string {
  const platform = os.platform();
  let base: string;
  if (platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support", "Kiro");
  } else if (platform === "win32") {
    base = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Kiro");
  } else {
    base = path.join(os.homedir(), ".config", "Kiro");
  }
  return path.join(base, "User", "globalStorage", "kiro.kiroagent", "profile.json");
}

function readJsonFile(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) { return null; }
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
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

/**
 * 清理日志文件中超过指定天数的行。
 * 行格式：[type] [ISO8601] {...}，从第二个 [...] 中提取时间戳。
 */
function cleanOldLines(filePath: string, days: number): void {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const kept = lines.filter((line) => {
      if (!line.trim()) return false;
      // 提取 [ISO8601] 时间戳
      const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
      if (!match) return true; // 无时间戳的行保留
      const ts = new Date(match[1]).getTime();
      return !isNaN(ts) && ts >= cutoff;
    });
    fs.writeFileSync(filePath, kept.join("\n") + "\n", "utf-8");
  } catch { /* best effort */ }
}
