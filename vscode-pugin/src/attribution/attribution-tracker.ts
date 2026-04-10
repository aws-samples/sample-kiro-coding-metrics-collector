/**
 * AttributionTracker - 行级归属追踪
 *
 * 核心逻辑：通过 diff 对比前后文件内容，更新每一行的归属信息。
 * - 新增的行 → 标记为当前 author
 * - 修改的行 → 标记为当前 author，overrode 设为原 author
 * - 删除的行 → 从归属列表中移除
 * - 未变化的行 → 保留原归属
 */

import { LineAttribution } from "./types";
import { computeLineDiff } from "./line-diff";

/**
 * 根据 diff 更新行级归属
 *
 * @param previousContent 上一次 checkpoint 的文件内容
 * @param currentContent 当前文件内容
 * @param previousAttrs 上一次的行级归属
 * @param authorId 当前编辑者 ID
 * @param isAi 是否为 AI 编辑
 * @returns 更新后的行级归属
 */
export function updateAttributions(
  previousContent: string,
  currentContent: string,
  previousAttrs: LineAttribution[],
  authorId: string,
  isAi: boolean
): LineAttribution[] {
  if (previousContent === currentContent) {
    return previousAttrs;
  }

  const ops = computeLineDiff(previousContent, currentContent);

  // 构建旧行号 → 归属的映射
  const oldLineAuthor = new Map<number, LineAttribution>();
  for (const attr of previousAttrs) {
    for (let line = attr.startLine; line <= attr.endLine; line++) {
      oldLineAuthor.set(line, attr);
    }
  }

  // 构建新行号 → 归属
  const newLineAuthors = new Map<number, { authorId: string; overrode?: string }>();
  const newLineCount = currentContent ? currentContent.split("\n").length : 0;

  for (const op of ops) {
    if (op.tag === "equal") {
      // 未变化的行：保留原归属
      const oldLine = op.oldStart;
      const newLine = op.newStart;
      const existing = oldLineAuthor.get(oldLine);
      if (existing) {
        newLineAuthors.set(newLine, {
          authorId: existing.authorId,
          overrode: existing.overrode,
        });
      }
    } else if (op.tag === "insert") {
      // 新增的行：标记为当前 author
      for (let line = op.newStart; line < op.newEnd; line++) {
        newLineAuthors.set(line, { authorId });
      }
    }
    // delete: 删除的行不出现在新文件中，无需处理
  }

  // 处理"替换"场景（delete + insert 在同一位置）
  // 如果一行被删除后在同一位置插入了新行，检查原行的 author
  // 如果原 author 不同于当前 author，标记为 overrode
  for (let i = 0; i < ops.length - 1; i++) {
    const curr = ops[i];
    const next = ops[i + 1];
    if (curr.tag === "delete" && next.tag === "insert") {
      // 这是一个替换操作
      const deletedLines = curr.oldEnd - curr.oldStart;
      const insertedLines = next.newEnd - next.newStart;
      const overlapCount = Math.min(deletedLines, insertedLines);

      for (let j = 0; j < overlapCount; j++) {
        const oldLine = curr.oldStart + j;
        const newLine = next.newStart + j;
        const originalAttr = oldLineAuthor.get(oldLine);

        if (originalAttr && originalAttr.authorId !== authorId) {
          // 不同 author 修改了这行 → mixed
          const existing = newLineAuthors.get(newLine);
          if (existing) {
            existing.overrode = originalAttr.authorId;
          }
        }
      }
    }
  }

  // 不再对未追踪的行做额外标记
  // 未变化的行已在 equal 分支中保留了原归属
  // 没有原归属的行保持无归属状态（human by default）

  // 压缩为 LineAttribution 数组
  return compressAttributions(newLineAuthors, newLineCount);
}

/** 将逐行的归属映射压缩为范围数组 */
function compressAttributions(
  lineAuthors: Map<number, { authorId: string; overrode?: string }>,
  totalLines: number
): LineAttribution[] {
  const result: LineAttribution[] = [];
  let current: LineAttribution | null = null;

  for (let line = 1; line <= totalLines; line++) {
    const info = lineAuthors.get(line);
    if (!info) {
      // 无归属信息的行，结束当前范围
      if (current) {
        result.push(current);
        current = null;
      }
      continue;
    }

    if (
      current &&
      current.authorId === info.authorId &&
      current.overrode === info.overrode &&
      current.endLine === line - 1
    ) {
      // 可以合并到当前范围
      current.endLine = line;
    } else {
      if (current) result.push(current);
      current = {
        startLine: line,
        endLine: line,
        authorId: info.authorId,
        overrode: info.overrode,
      };
    }
  }

  if (current) result.push(current);
  return result;
}
