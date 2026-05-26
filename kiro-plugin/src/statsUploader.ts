import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getGitAiBinary, getIgnorePatterns } from "./checkpoint";

import { STATS_URL } from "./apiConfig";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000;

/** CommitStats as output by `git-ai stats <sha> --json`. */
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
  tool_model_breakdown: Record<string, ToolModelStats>;
}

interface ToolModelStats {
  ai_additions: number;
  mixed_additions: number;
  ai_accepted: number;
  total_ai_additions: number;
  total_ai_deletions: number;
  time_waiting_for_ai: number;
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

/**
 * Upload stats for a specific commit.
 * Runs `git-ai stats <commitSha> --json` to get precise attribution data,
 * then POSTs it to the configured endpoint.
 * No-ops silently if URL or token is not configured.
 */
export async function uploadCommitStats(
  workspaceDir: string,
  commitSha: string
): Promise<void> {
  const binary = getGitAiBinary();
  if (!binary) {
    console.error("[git-ai-kiro] Cannot upload commit stats: bundled binary not found");
    return;
  }

  try {
    // Query stats, retrying if authorship note hasn't been written yet.
    // git-ai's post-commit hook may still be running when we first query.
    const commitStats = await queryCommitStatsWithRetry(binary, workspaceDir, commitSha);
    if (!commitStats) {
      console.log(`[git-ai-kiro] No stats available for commit ${commitSha.slice(0, 8)}, skipping upload`);
      return;
    }

    const machineId = crypto
      .createHash("sha256")
      .update(os.hostname())
      .digest("hex");

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

    const idempotencyKey = generateIdempotencyKey(commitSha, machineId);
    await postWithRetry(STATS_URL, idempotencyKey, payload);
    console.log(`[git-ai-kiro] Commit stats uploaded: ${commitSha.slice(0, 8)}`);
  } catch (err) {
    console.error(`[git-ai-kiro] Commit stats upload failed: ${err}`);
  }
}

/**
 * Run `git-ai stats <commitSha> --json` and parse the output.
 * Passes ignore patterns from configuration to exclude specified directories/files.
 */
function queryCommitStats(
  binary: string,
  cwd: string,
  commitSha: string
): Promise<CommitStats | null> {
  return new Promise((resolve) => {
    const args = ["stats", commitSha, "--json"];

    // Add ignore patterns from configuration.
    // Convert simple directory names (e.g. "pkg") to glob format ("**/pkg/**")
    // so the Rust-side IgnoreMatcher can match paths like "pkg/file.ts".
    const ignorePatterns = getIgnorePatterns();
    if (ignorePatterns.length > 0) {
      const globPatterns = ignorePatterns.map((p) => {
        // Already a glob pattern (contains * or **) — pass through
        if (p.includes("*")) return p;
        // Simple directory/file name — wrap as recursive glob
        return `**/${p}/**`;
      });
      args.push("--ignore", ...globPatterns);
    }

    const proc = spawn(binary, args, {
      cwd,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("error", (err) => {
      console.error(`[git-ai-kiro] git-ai stats spawn error: ${err}`);
      resolve(null);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        if (stderr.trim()) {
          console.log(`[git-ai-kiro] git-ai stats stderr: ${stderr.trim()}`);
        }
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        console.error("[git-ai-kiro] Failed to parse git-ai stats JSON output");
        resolve(null);
      }
    });
  });
}

/**
 * Query commit stats with retry. If the first query returns stats where
 * all lines are attributed to human (no AI attribution), it may mean the
 * post-commit hook hasn't finished writing the authorship note yet.
 * In that case, wait and retry up to 3 times.
 *
 * For purely human commits (no AI involvement), the stats will correctly
 * show human_additions == git_diff_added_lines on every attempt, so we
 * won't retry unnecessarily — we detect "missing note" by checking if
 * git_diff_added_lines > 0 but ai_additions + human_additions == 0.
 */
const NOTE_RETRY_COUNT = 3;
const NOTE_RETRY_DELAY_MS = 2_000;

async function queryCommitStatsWithRetry(
  binary: string,
  cwd: string,
  commitSha: string
): Promise<CommitStats | null> {
  for (let attempt = 0; attempt <= NOTE_RETRY_COUNT; attempt++) {
    if (attempt > 0) {
      console.log(
        `[git-ai-kiro] Retrying stats query (${attempt}/${NOTE_RETRY_COUNT}) for ${commitSha.slice(0, 8)}...`
      );
      await sleep(NOTE_RETRY_DELAY_MS);
    }

    const stats = await queryCommitStats(binary, cwd, commitSha);
    if (!stats) {
      return null;
    }

    // Check if authorship data looks complete.
    // If there are added lines but zero attribution (both human and AI are 0),
    // the authorship note likely hasn't been written yet.
    const hasAddedLines = stats.git_diff_added_lines > 0;
    const hasAttribution = (stats.human_additions + stats.ai_additions) > 0;

    if (!hasAddedLines || hasAttribution) {
      return stats;
    }

    console.log(
      `[git-ai-kiro] Stats for ${commitSha.slice(0, 8)} show ${stats.git_diff_added_lines} added lines ` +
      `but 0 attribution — authorship note may not be ready yet`
    );
  }

  // Return whatever we got on the last attempt
  console.log(`[git-ai-kiro] Giving up waiting for authorship note, uploading current stats`);
  return queryCommitStats(binary, cwd, commitSha);
}

function getRepoName(workspaceDir: string): string {
  const remoteUrl = gitConfigValue(workspaceDir, "remote.origin.url");
  if (remoteUrl) {
    const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) {
      return match[1];
    }
  }
  return path.basename(workspaceDir);
}

function generateIdempotencyKey(
  commitSha: string,
  machineId: string
): string {
  const raw = `${commitSha}:${machineId}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function gitExec(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout: 5_000,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

function gitConfigValue(cwd: string, key: string): string {
  return gitExec(cwd, ["config", key]);
}

async function postWithRetry(
  url: string,
  idempotencyKey: string,
  payload: UploadPayload
): Promise<void> {
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(
        `[git-ai-kiro] Stats upload retry ${attempt}/${MAX_RETRIES} after ${delay}ms`
      );
      await sleep(delay);
    }

    try {
      const statusCode = await doPost(url, idempotencyKey, body);

      if (statusCode >= 200 && statusCode < 300) {
        return;
      }

      if (statusCode >= 400 && statusCode < 500) {
        console.error(
          `[git-ai-kiro] Stats upload got HTTP ${statusCode}, not retrying`
        );
        return;
      }

      console.warn(
        `[git-ai-kiro] Stats upload got HTTP ${statusCode}, will retry`
      );
    } catch (err) {
      console.warn(`[git-ai-kiro] Stats upload network error: ${err}`);
      if (attempt === MAX_RETRIES) {
        throw err;
      }
    }
  }
}

function doPost(
  url: string,
  idempotencyKey: string,
  body: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });

    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
