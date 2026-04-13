/**
 * StatsCalculator - 从 checkpoint 数据计算 commit 级别的统计
 *
 * 关键逻辑：
 *   aiAccepted = commit 中新增的行 ∩ AI 归属的行（未被 human 覆盖）
 *   mixed = commit 中新增的行 ∩ 被不同 author 覆盖的行
 *   humanAdditions = commit 新增总行数 - aiAccepted
 *
 * 不能直接统计 checkpoint 中所有 AI 归属行——那会包含之前 commit 就有的行。
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Checkpoint, CommitStats } from "./types";
import { shouldIgnoreFile } from "./ignore-patterns";

export function calculateCommitStats(workDir: string, commitSha: string): CommitStats {
  const parentSha = getParentCommit(workDir, commitSha);
  const checkpoints = readCheckpointsForBase(workDir, parentSha);

  console.log(`[kiro-ai-coverage] Stats: ${checkpoints.length} checkpoints under base ${parentSha.slice(0, 8)}`);

  const { added, deleted } = getCommitDiffStats(workDir, commitSha);

  if (checkpoints.length === 0) {
    return emptyStats(added, deleted);
  }

  // 1. 获取 commit 中每个文件实际新增的行号
  const commitAddedLines = getCommitAddedLinesByFile(workDir, commitSha);

  // 2. 从 checkpoints 中取每个文件的最终归属（后面的 checkpoint 覆盖前面的）
  const fileLineAttrs = new Map<string, Map<number, { authorId: string; overrode?: string }>>();

  for (const cp of checkpoints) {
    for (const entry of cp.entries) {
      let lineMap = fileLineAttrs.get(entry.file);
      if (!lineMap) {
        lineMap = new Map();
        fileLineAttrs.set(entry.file, lineMap);
      }
      for (const la of entry.lineAttributions) {
        for (let line = la.startLine; line <= la.endLine; line++) {
          lineMap.set(line, { authorId: la.authorId, overrode: la.overrode });
        }
      }
    }
  }

  // 3. 只统计 commit 新增行中有 AI 归属的
  let aiAccepted = 0;
  let mixedAdditions = 0;

  for (const [file, addedLineNumbers] of commitAddedLines) {
    const lineMap = fileLineAttrs.get(file);
    if (!lineMap) continue;

    for (const lineNum of addedLineNumbers) {
      const attr = lineMap.get(lineNum);
      if (!attr) continue;

      if (attr.authorId !== "human") {
        if (attr.overrode) {
          mixedAdditions++;
        } else {
          aiAccepted++;
        }
      } else if (attr.overrode && attr.overrode !== "human") {
        // human 覆盖了 AI
        mixedAdditions++;
      }
    }
  }

  // 4. 聚合 checkpoint 的 lineStats（totalAiAdditions/Deletions 是工作过程中的总量）
  let totalAiAdditions = 0;
  let totalAiDeletions = 0;
  for (const cp of checkpoints) {
    if (cp.kind === "ai_agent") {
      totalAiAdditions += cp.lineStats.additions;
      totalAiDeletions += cp.lineStats.deletions;
    }
  }

  // aiAdditions = 纯AI行 + 混合行（AI参与的总行数）
  // humanAdditions = 纯human行 + 混合行（human参与的总行数）
  // mixedAdditions 单独计数，与 ai/human 有重叠
  const aiAdditions = aiAccepted + mixedAdditions;
  const humanAdditions = Math.max(0, added - aiAccepted);

  const toolBreakdown: CommitStats["toolModelBreakdown"] = {};
  if (totalAiAdditions > 0 || totalAiDeletions > 0 || aiAccepted > 0) {
    toolBreakdown["kiro::kiro-ai"] = {
      aiAdditions, aiAccepted, mixedAdditions, totalAiAdditions, totalAiDeletions,
    };
  }

  return {
    humanAdditions, aiAdditions, aiAccepted, mixedAdditions,
    totalAiAdditions, totalAiDeletions,
    gitDiffAddedLines: added, gitDiffDeletedLines: deleted,
    toolModelBreakdown: toolBreakdown,
  };
}

/**
 * 获取 commit 中每个文件新增的行号
 * 使用 git diff -U0 解析 @@ hunk headers
 */
function getCommitAddedLinesByFile(workDir: string, commitSha: string): Map<string, number[]> {
  const result = new Map<string, number[]>();
  try {
    const output = execFileSync(
      "git", ["diff", "-U0", `${commitSha}~1`, commitSha],
      { cwd: workDir, timeout: 15000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
    );

    let currentFile = "";
    for (const line of output.split("\n")) {
      // 文件头: diff --git a/foo.java b/foo.java
      if (line.startsWith("diff --git")) {
        const match = line.match(/b\/(.+)$/);
        if (match) {
          currentFile = shouldIgnoreFile(match[1]) ? "" : match[1];
        }
        continue;
      }
      // Hunk header: @@ -old,count +new,count @@
      if (line.startsWith("@@") && currentFile) {
        const match = line.match(/\+(\d+)(?:,(\d+))?/);
        if (match) {
          const start = parseInt(match[1], 10);
          const count = match[2] ? parseInt(match[2], 10) : 1;
          if (count > 0) {
            let lines = result.get(currentFile) || [];
            for (let i = 0; i < count; i++) {
              lines.push(start + i);
            }
            result.set(currentFile, lines);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[kiro-ai-coverage] Failed to get commit added lines: ${err}`);
  }
  return result;
}

function emptyStats(added: number, deleted: number): CommitStats {
  return {
    humanAdditions: added, aiAdditions: 0, aiAccepted: 0, mixedAdditions: 0,
    totalAiAdditions: 0, totalAiDeletions: 0,
    gitDiffAddedLines: added, gitDiffDeletedLines: deleted,
    toolModelBreakdown: {},
  };
}

function getParentCommit(workDir: string, commitSha: string): string {
  try {
    return execFileSync("git", ["rev-parse", `${commitSha}~1`], {
      cwd: workDir, timeout: 5000, encoding: "utf-8",
    }).trim();
  } catch { return "initial"; }
}

function readCheckpointsForBase(workDir: string, baseSha: string): Checkpoint[] {
  const cpFile = path.join(workDir, ".git", "ai", "working_logs", baseSha, "checkpoints.jsonl");
  if (!fs.existsSync(cpFile)) {
    const aiDir = path.join(workDir, ".git", "ai", "working_logs");
    if (fs.existsSync(aiDir)) {
      try {
        const dirs = fs.readdirSync(aiDir);
        const match = dirs.find((d) => d.startsWith(baseSha.slice(0, 8)) || baseSha.startsWith(d.slice(0, 8)));
        if (match) {
          const altFile = path.join(aiDir, match, "checkpoints.jsonl");
          if (fs.existsSync(altFile)) return parseCheckpointsFile(altFile);
        }
      } catch { /* */ }
    }
    return [];
  }
  return parseCheckpointsFile(cpFile);
}

function parseCheckpointsFile(filePath: string): Checkpoint[] {
  try {
    return fs.readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch { return []; }
}

function getCommitDiffStats(workDir: string, commitSha: string): { added: number; deleted: number } {
  try {
    const output = execFileSync(
      "git", ["diff", "--numstat", `${commitSha}~1`, commitSha],
      { cwd: workDir, timeout: 10000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    let added = 0, deleted = 0;
    for (const line of output.split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 3) {
        // numstat 格式: added\tdeleted\tfilepath
        const filePath = parts[2];
        if (shouldIgnoreFile(filePath)) continue;
        const a = parseInt(parts[0], 10);
        const d = parseInt(parts[1], 10);
        if (!isNaN(a)) added += a;
        if (!isNaN(d)) deleted += d;
      }
    }
    return { added, deleted };
  } catch { return { added: 0, deleted: 0 }; }
}
