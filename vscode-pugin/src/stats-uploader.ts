/**
 * StatsUploader - 查询 git-ai stats 并上报到 HTTP 接口
 *
 * 配置项（VSCode settings）：
 *   gitai.kiro.statsUploadUrl   - 上报 URL
 *   gitai.kiro.statsUploadToken - Bearer token
 */

import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getGitAiBinary } from "./utils/binary-path";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000;
const NOTE_RETRY_COUNT = 3;
const NOTE_RETRY_DELAY_MS = 2_000;

interface CommitStats {
  human_additions: number;
  mixed_additions: number;
  ai_additions: number;
  ai_accepted: number;
  total_ai_additions: number;
  total_ai_deletions: number;
  time_waiting_for_ai: number;
  git_diff_added_lines: number;
  git_diff_deleted_lines: number;
  tool_model_breakdown: Record<string, unknown>;
}

interface UploadPayload {
  repo_name: string;
  repo_remote_url: string;
  branch: string;
  commit_sha: string;
  machine_id: string;
  user_name: string;
  user_email: string;
  reported_at: string;
  commit_stats: CommitStats;
}

export async function uploadCommitStats(
  workspaceDir: string,
  commitSha: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration("gitai.kiro");
  const url = config.get<string>("statsUploadUrl") ?? "";
  const token = config.get<string>("statsUploadToken") ?? "";

  if (!url) {
    console.log("[git-ai-kiro] statsUploadUrl not configured, skipping upload");
    return;
  }

  // 校验 URL 格式
  try {
    new URL(url);
  } catch {
    console.error(`[git-ai-kiro] Invalid statsUploadUrl: ${url}`);
    return;
  }

  const binary = getGitAiBinary();

  try {
    const commitStats = await queryCommitStatsWithRetry(binary, workspaceDir, commitSha);
    if (!commitStats) {
      console.log(`[git-ai-kiro] No stats for commit ${commitSha.slice(0, 8)}, skipping`);
      return;
    }

    const machineId = crypto.createHash("sha256").update(os.hostname()).digest("hex");

    const payload: UploadPayload = {
      repo_name: getRepoName(workspaceDir),
      repo_remote_url: gitConfigValue(workspaceDir, "remote.origin.url"),
      branch: gitExec(workspaceDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
      commit_sha: commitSha,
      machine_id: machineId,
      user_name: gitConfigValue(workspaceDir, "user.name"),
      user_email: gitConfigValue(workspaceDir, "user.email"),
      reported_at: new Date().toISOString(),
      commit_stats: commitStats,
    };

    const idempotencyKey = crypto.createHash("sha256")
      .update(`${commitSha}:${machineId}`).digest("hex");

    await postWithRetry(url, token, idempotencyKey, payload);
    console.log(`[git-ai-kiro] Stats uploaded: ${commitSha.slice(0, 8)}`);
  } catch (err) {
    // 静默处理上报错误，不影响用户体验
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`[git-ai-kiro] Stats upload skipped: ${errMsg}`);
  }
}

function queryCommitStats(binary: string, cwd: string, commitSha: string): Promise<CommitStats | null> {
  return new Promise((resolve) => {
    const proc = spawn(binary, ["stats", commitSha, "--json"], { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

async function queryCommitStatsWithRetry(
  binary: string, cwd: string, commitSha: string
): Promise<CommitStats | null> {
  for (let attempt = 0; attempt <= NOTE_RETRY_COUNT; attempt++) {
    if (attempt > 0) {
      console.log(`[git-ai-kiro] Retrying stats query (${attempt}/${NOTE_RETRY_COUNT})...`);
      await sleep(NOTE_RETRY_DELAY_MS);
    }
    const stats = await queryCommitStats(binary, cwd, commitSha);
    if (!stats) return null;

    const hasAddedLines = stats.git_diff_added_lines > 0;
    const hasAttribution = (stats.human_additions + stats.ai_additions) > 0;
    if (!hasAddedLines || hasAttribution) return stats;

    console.log(`[git-ai-kiro] Stats show ${stats.git_diff_added_lines} added but 0 attribution, note may not be ready`);
  }
  return queryCommitStats(binary, cwd, commitSha);
}

function getRepoName(cwd: string): string {
  const url = gitConfigValue(cwd, "remote.origin.url");
  if (url) {
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  return path.basename(cwd);
}

function gitExec(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, timeout: 5_000, encoding: "utf-8" }).trim();
  } catch { return ""; }
}

function gitConfigValue(cwd: string, key: string): string {
  return gitExec(cwd, ["config", key]);
}

async function postWithRetry(url: string, token: string, idempotencyKey: string, payload: UploadPayload): Promise<void> {
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[git-ai-kiro] Stats upload retry ${attempt}/${MAX_RETRIES}`);
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1));
    }
    try {
      const code = await doPost(url, token, idempotencyKey, body);
      if (code === 0) return; // 连接失败（已在 doPost 中记录日志），不重试
      if (code >= 200 && code < 300) return;
      if (code >= 400 && code < 500) {
        console.error(`[git-ai-kiro] Stats upload got HTTP ${code}, not retrying`);
        return;
      }
      console.warn(`[git-ai-kiro] Stats upload got HTTP ${code}, will retry`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // DNS/connection errors: don't retry, the URL is likely wrong
      if (msg.includes("ENOTFOUND") || msg.includes("ECONNREFUSED") || msg.includes("AggregateError")) {
        console.log(`[git-ai-kiro] Stats endpoint unreachable, not retrying: ${msg}`);
        return;
      }
      console.warn(`[git-ai-kiro] Stats upload error: ${msg}`);
      if (attempt === MAX_RETRIES) throw err;
    }
  }
}

function doPost(url: string, token: string, idempotencyKey: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
        "X-Idempotency-Key": idempotencyKey,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });

    req.on("error", (err) => {
      // 连接失败（ECONNREFUSED、DNS 失败等）静默处理
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT" || err.name === "AggregateError") {
        console.log(`[git-ai-kiro] Stats endpoint unreachable (${code || err.name}): ${parsed.hostname}`);
        resolve(0); // 返回 0 表示连接失败，不重试
      } else {
        reject(err);
      }
    });
    req.on("timeout", () => {
      req.destroy();
      console.log("[git-ai-kiro] Stats upload request timed out");
      resolve(0);
    });

    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
