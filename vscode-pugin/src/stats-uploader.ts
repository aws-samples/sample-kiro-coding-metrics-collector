/**
 * StatsUploader - 使用内置归属追踪计算 stats 并上报
 * 不依赖 git-ai CLI。
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { calculateCommitStats } from "./attribution/stats-calculator";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000;

interface UploadPayload {
  repo_name: string;
  repo_remote_url: string;
  branch: string;
  commit_sha: string;
  machine_id: string;
  user_name: string;
  user_email: string;
  reported_at: string;
  commit_stats: Record<string, unknown>;
}

export async function uploadCommitStats(
  workspaceDir: string,
  commitSha: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration("kiroAiCoverage");
  const url = config.get<string>("statsUploadUrl") ?? "";
  const token = config.get<string>("statsUploadToken") ?? "";

  if (!url) return;

  try { new URL(url); } catch { return; }

  try {
    const native = calculateCommitStats(workspaceDir, commitSha);

    const commitStats = {
      human_additions: native.humanAdditions,
      mixed_additions: native.mixedAdditions,
      ai_additions: native.aiAdditions,
      ai_accepted: native.aiAccepted,
      total_ai_additions: native.totalAiAdditions,
      total_ai_deletions: native.totalAiDeletions,
      time_waiting_for_ai: 0,
      git_diff_added_lines: native.gitDiffAddedLines,
      git_diff_deleted_lines: native.gitDiffDeletedLines,
      tool_model_breakdown: Object.fromEntries(
        Object.entries(native.toolModelBreakdown).map(([k, v]) => [k, {
          ai_additions: v.aiAdditions,
          mixed_additions: v.mixedAdditions,
          ai_accepted: v.aiAccepted,
          total_ai_additions: v.totalAiAdditions,
          total_ai_deletions: v.totalAiDeletions,
          time_waiting_for_ai: 0,
        }])
      ),
    };

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
    console.log(`[kiro-ai-coverage] Stats uploaded: ${commitSha.slice(0, 8)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[kiro-ai-coverage] Stats upload skipped: ${msg}`);
  }
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
    if (attempt > 0) await sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1));
    try {
      const code = await doPost(url, token, idempotencyKey, body);
      if (code === 0) return;
      if (code >= 200 && code < 300) return;
      if (code >= 400 && code < 500) return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOTFOUND") || msg.includes("ECONNREFUSED") || msg.includes("AggregateError")) return;
      if (attempt === MAX_RETRIES) throw err;
    }
  }
}

function doPost(url: string, token: string, idempotencyKey: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-Idempotency-Key": idempotencyKey,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
        resolve(0);
      } else { reject(err); }
    });
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
