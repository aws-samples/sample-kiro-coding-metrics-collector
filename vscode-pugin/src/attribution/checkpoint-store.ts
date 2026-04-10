/**
 * CheckpointStore - 在 .git/ai/working_logs/ 中存储 checkpoint
 *
 * 兼容 git-ai 的目录结构：
 *   .git/ai/working_logs/<base_commit>/checkpoints.jsonl
 *   .git/ai/working_logs/<base_commit>/blobs/<sha256>
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { Checkpoint, CheckpointEntry, LineAttribution, CheckpointKind } from "./types";
import { updateAttributions } from "./attribution-tracker";
import { countChanges } from "./line-diff";

export class CheckpointStore {
  private readonly gitDir: string;
  private readonly workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
    this.gitDir = path.join(workDir, ".git", "ai");
    fs.mkdirSync(this.gitDir, { recursive: true });
  }

  /** 获取当前 HEAD commit SHA */
  private getHeadCommit(): string {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.workDir, timeout: 5000, encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      return "initial";
    }
  }

  /** 获取 working_logs 目录 */
  private getWorkingLogDir(): string {
    const baseCommit = this.getHeadCommit();
    const dir = path.join(this.gitDir, "working_logs", baseCommit);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "blobs"), { recursive: true });
    return dir;
  }

  /** 读取所有已有的 checkpoints */
  readCheckpoints(): Checkpoint[] {
    const logDir = this.getWorkingLogDir();
    const cpFile = path.join(logDir, "checkpoints.jsonl");
    if (!fs.existsSync(cpFile)) return [];

    return fs.readFileSync(cpFile, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }

  /** 保存文件内容到 blobs，返回 SHA256 */
  private saveBlob(logDir: string, content: string): string {
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const blobPath = path.join(logDir, "blobs", sha);
    if (!fs.existsSync(blobPath)) {
      fs.writeFileSync(blobPath, content);
    }
    return sha;
  }

  /** 读取 blob 内容 */
  private readBlob(logDir: string, sha: string): string {
    const blobPath = path.join(logDir, "blobs", sha);
    if (fs.existsSync(blobPath)) {
      return fs.readFileSync(blobPath, "utf-8");
    }
    return "";
  }

  /** 获取文件在 HEAD 中的内容 */
  private getHeadContent(filePath: string): string {
    try {
      return execFileSync("git", ["show", `HEAD:${filePath}`], {
        cwd: this.workDir, timeout: 5000, encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return "";
    }
  }

  /**
   * 执行 checkpoint
   * @param kind human 或 ai_agent
   * @param authorId 编辑者 ID
   * @param filePaths 被编辑的文件路径（绝对路径）
   */
  executeCheckpoint(
    kind: CheckpointKind,
    authorId: string,
    filePaths?: string[]
  ): Checkpoint | null {
    const logDir = this.getWorkingLogDir();
    const existingCheckpoints = this.readCheckpoints();

    // 确定要处理的文件
    let files: string[];
    if (filePaths && filePaths.length > 0) {
      files = filePaths.map((fp) => path.relative(this.workDir, fp));
    } else {
      // 获取所有有变更的文件
      files = this.getChangedFiles();
    }

    if (files.length === 0) return null;

    const entries: CheckpointEntry[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const file of files) {
      const absPath = path.join(this.workDir, file);
      if (!fs.existsSync(absPath)) continue;

      const currentContent = fs.readFileSync(absPath, "utf-8");
      const blobSha = this.saveBlob(logDir, currentContent);

      // 获取上一次 checkpoint 的内容和归属
      const { previousContent, previousAttrs } = this.getPreviousState(
        file, existingCheckpoints, logDir
      );

      if (currentContent === previousContent) continue;

      // 计算行级变更
      const { additions, deletions } = countChanges(previousContent, currentContent);
      totalAdditions += additions;
      totalDeletions += deletions;

      // 更新归属
      const newAttrs = updateAttributions(
        previousContent,
        currentContent,
        previousAttrs,
        authorId,
        kind === "ai_agent"
      );

      entries.push({
        file,
        blobSha,
        lineAttributions: newAttrs,
        additions,
        deletions,
      });
    }

    if (entries.length === 0) return null;

    const checkpoint: Checkpoint = {
      kind,
      authorId,
      timestamp: Math.floor(Date.now() / 1000),
      entries,
      lineStats: { additions: totalAdditions, deletions: totalDeletions },
    };

    // 追加到 checkpoints.jsonl
    const cpFile = path.join(logDir, "checkpoints.jsonl");
    fs.appendFileSync(cpFile, JSON.stringify(checkpoint) + "\n");

    console.log(
      `[kiro-ai-coverage] ${kind} checkpoint: ${entries.length} file(s), +${totalAdditions} -${totalDeletions}`
    );

    return checkpoint;
  }

  /** 获取文件的上一次 checkpoint 状态 */
  private getPreviousState(
    file: string,
    checkpoints: Checkpoint[],
    logDir: string
  ): { previousContent: string; previousAttrs: LineAttribution[] } {
    // 从最新的 checkpoint 向前查找
    for (let i = checkpoints.length - 1; i >= 0; i--) {
      const entry = checkpoints[i].entries.find((e) => e.file === file);
      if (entry) {
        return {
          previousContent: this.readBlob(logDir, entry.blobSha),
          previousAttrs: entry.lineAttributions,
        };
      }
    }
    // 没有 checkpoint，使用 HEAD 中的内容
    return {
      previousContent: this.getHeadContent(file),
      previousAttrs: [],
    };
  }

  /** 获取工作区中有变更的文件 */
  private getChangedFiles(): string[] {
    try {
      const output = execFileSync("git", ["status", "--porcelain"], {
        cwd: this.workDir, timeout: 10000, encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => line.substring(3).trim())
        .filter((file) => !file.startsWith(".git/"));
    } catch {
      return [];
    }
  }
}
