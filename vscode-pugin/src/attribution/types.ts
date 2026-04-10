/** 行级归属记录 */
export interface LineAttribution {
  startLine: number; // 1-indexed, inclusive
  endLine: number;   // 1-indexed, inclusive
  authorId: string;  // "human" 或 AI session hash (如 "kiro-1234567890")
  overrode?: string; // 被覆盖的原 author（有值 = mixed 编辑）
}

/** Checkpoint 类型 */
export type CheckpointKind = "human" | "ai_agent";

/** 单个文件的 checkpoint 条目 */
export interface CheckpointEntry {
  file: string;                    // 相对于 git root 的文件路径
  blobSha: string;                 // 文件内容的 SHA256
  lineAttributions: LineAttribution[];
  additions: number;               // 本次 checkpoint 新增行数
  deletions: number;               // 本次 checkpoint 删除行数
}

/** 一次 checkpoint 快照 */
export interface Checkpoint {
  kind: CheckpointKind;
  authorId: string;                // "human" 或 AI session ID
  timestamp: number;               // Unix seconds
  entries: CheckpointEntry[];
  lineStats: { additions: number; deletions: number };
}

/** Commit 级别的统计 */
export interface CommitStats {
  humanAdditions: number;
  aiAdditions: number;
  aiAccepted: number;              // AI 生成且未被人工修改的行
  mixedAdditions: number;          // AI 生成但被人工修改的行
  totalAiAdditions: number;        // 工作过程中 AI 总新增行数
  totalAiDeletions: number;        // 工作过程中 AI 总删除行数
  gitDiffAddedLines: number;
  gitDiffDeletedLines: number;
  toolModelBreakdown: Record<string, {
    aiAdditions: number;
    aiAccepted: number;
    mixedAdditions: number;
    totalAiAdditions: number;
    totalAiDeletions: number;
  }>;
}

/** Prompt 记录（对应 git-ai 的 PromptRecord） */
export interface PromptRecord {
  agentId: { tool: string; id: string; model: string };
  totalAdditions: number;
  totalDeletions: number;
  acceptedLines: number;
  overriddenLines: number;
}
