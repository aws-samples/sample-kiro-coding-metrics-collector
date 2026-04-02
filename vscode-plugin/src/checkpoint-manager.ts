/**
 * CheckpointManager - 在扩展进程内调用 git-ai checkpoint
 *
 * 只负责 ai_agent checkpoint。human checkpoint 由 Kiro hooks 处理。
 *
 * AI 活跃窗口机制：
 *   - promptSubmit hook 写入标记文件 /tmp/.git-ai-kiro-active
 *   - agentStop hook 删除标记文件
 *   - isAiActive() 检查标记文件是否存在且不超过 10 分钟
 *   - 只在 AI 活跃窗口内，onDidSaveTextDocument 才触发 ai_agent checkpoint
 */

import * as vscode from "vscode";
import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getGitRepoRoot } from "./utils/git-api";
import { AGENT_V1_PRESET } from "./consts";

const SID_FILE = "/tmp/.git-ai-kiro-sid";
const ACTIVE_FILE = "/tmp/.git-ai-kiro-active";
const MAX_ACTIVE_AGE_MS = 10 * 60 * 1000; // 10 分钟超时

export class CheckpointManager {
  private gitAiBin: string | null = null;
  private pendingFiles = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_MS = 3000; // 3 秒防抖，确保文件已写入磁盘

  constructor() {
    this.resolveGitAi();
  }

  /** 检查 AI agent 是否正在活跃（标记文件存在且未超时） */
  isAiActive(): boolean {
    try {
      if (!fs.existsSync(ACTIVE_FILE)) return false;
      const stat = fs.statSync(ACTIVE_FILE);
      const age = Date.now() - stat.mtimeMs;
      return age < MAX_ACTIVE_AGE_MS;
    } catch {
      return false;
    }
  }

  /** 调度 AI checkpoint，带防抖合并多个文件 */
  scheduleAiCheckpoint(filePaths: string[]): void {
    for (const fp of filePaths) this.pendingFiles.add(fp);

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const files = Array.from(this.pendingFiles);
      this.pendingFiles.clear();
      if (files.length > 0) this.runAiCheckpoint(files);
    }, this.DEBOUNCE_MS);
  }

  isAvailable(): boolean {
    return this.resolveGitAi() !== null;
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pendingFiles.clear();
  }

  // === 内部实现 ===

  private async runAiCheckpoint(filePaths: string[]): Promise<void> {
    const bin = this.resolveGitAi();
    if (!bin) return;

    // 按 git 仓库分组
    const repoFiles = new Map<string, string[]>();
    for (const fp of filePaths) {
      const repo = this.findGitRoot(fp);
      if (!repo) continue;
      const list = repoFiles.get(repo) || [];
      list.push(fp);
      repoFiles.set(repo, list);
    }

    // 读取 session ID
    let sid: string;
    try {
      sid = fs.readFileSync(SID_FILE, "utf-8").trim();
    } catch {
      sid = `kiro-${Date.now()}-ext`;
      try { fs.writeFileSync(SID_FILE, sid); } catch { /* */ }
    }

    for (const [repo] of repoFiles) {
      const input = JSON.stringify({
        type: "ai_agent",
        repo_working_dir: repo,
        agent_name: "kiro",
        model: "kiro-ai",
        conversation_id: sid,
        transcript: { messages: [{ type: "assistant", text: "Kiro AI edit" }] },
      });

      console.log(`[git-ai-kiro] ai_agent checkpoint: ${repo}`);

      try {
        await this.execCheckpoint(bin, input, repo);
      } catch (err) {
        console.error(`[git-ai-kiro] checkpoint 失败:`, err);
      }
    }
  }

  private execCheckpoint(bin: string, input: string, cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, ["checkpoint", AGENT_V1_PRESET, "--hook-input", "stdin"], { cwd });
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) {
          console.error(`[git-ai-kiro] exit ${code}: ${stderr}`);
        } else {
          console.log(`[git-ai-kiro] checkpoint OK: ${stderr.trim()}`);
        }
        resolve();
      });
      proc.stdin.write(input);
      proc.stdin.end();
    });
  }

  private findGitRoot(filePath: string): string | null {
    try {
      const root = getGitRepoRoot(vscode.Uri.file(filePath));
      if (root) return root;
    } catch { /* */ }

    let dir = path.dirname(filePath);
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  private resolveGitAi(): string | null {
    if (this.gitAiBin) return this.gitAiBin;

    try {
      execSync("git-ai --version", { timeout: 3000, stdio: "ignore" });
      this.gitAiBin = "git-ai";
      return this.gitAiBin;
    } catch { /* */ }

    try {
      const p = execSync('bash -ilc "which git-ai" 2>/dev/null', {
        timeout: 5000, encoding: "utf-8",
      }).trim();
      if (p && fs.existsSync(p)) { this.gitAiBin = p; return p; }
    } catch { /* */ }

    for (const p of [
      `${process.env.HOME}/.git-ai/bin/git-ai`,
      `${process.env.HOME}/.cargo/bin/git-ai`,
      "/usr/local/bin/git-ai",
      "/opt/homebrew/bin/git-ai",
    ]) {
      if (fs.existsSync(p)) { this.gitAiBin = p; return p; }
    }
    return null;
  }
}
