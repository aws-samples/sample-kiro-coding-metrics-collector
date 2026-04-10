/**
 * 行级 diff 计算
 * 对比两个文本的行差异，返回操作列表（insert/delete/equal）
 */

export interface DiffOp {
  tag: "equal" | "insert" | "delete";
  oldStart: number; // 1-indexed, 在旧文本中的起始行
  oldEnd: number;   // 1-indexed, exclusive
  newStart: number; // 1-indexed, 在新文本中的起始行
  newEnd: number;   // 1-indexed, exclusive
}

/**
 * Myers diff 算法的简化实现，计算行级差异
 */
export function computeLineDiff(oldText: string, newText: string): DiffOp[] {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];

  // LCS-based diff
  const lcs = longestCommonSubsequence(oldLines, newLines);
  return buildDiffOps(oldLines, newLines, lcs);
}

/** 计算新增行数和删除行数 */
export function countChanges(oldText: string, newText: string): { additions: number; deletions: number } {
  const ops = computeLineDiff(oldText, newText);
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.tag === "insert") additions += op.newEnd - op.newStart;
    if (op.tag === "delete") deletions += op.oldEnd - op.oldStart;
  }
  return { additions, deletions };
}

// LCS 表（返回匹配的行索引对）
function longestCommonSubsequence(a: string[], b: string[]): [number, number][] {
  const m = a.length;
  const n = b.length;

  // 优化：对于大文件使用 O(ND) 近似
  if (m * n > 1_000_000) {
    return greedyLCS(a, b);
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯
  const result: [number, number][] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift([i - 1, j - 1]);
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result;
}

// 大文件的贪心 LCS（线性时间近似）
function greedyLCS(a: string[], b: string[]): [number, number][] {
  const bIndex = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const list = bIndex.get(b[j]) || [];
    list.push(j);
    bIndex.set(b[j], list);
  }

  const result: [number, number][] = [];
  let lastJ = -1;
  for (let i = 0; i < a.length; i++) {
    const candidates = bIndex.get(a[i]);
    if (!candidates) continue;
    // 找到第一个 > lastJ 的 j
    for (const j of candidates) {
      if (j > lastJ) {
        result.push([i, j]);
        lastJ = j;
        break;
      }
    }
  }
  return result;
}

function buildDiffOps(oldLines: string[], newLines: string[], lcs: [number, number][]): DiffOp[] {
  const ops: DiffOp[] = [];
  let oldIdx = 0;
  let newIdx = 0;

  for (const [oi, ni] of lcs) {
    // 删除的行（在旧文本中有，LCS 中没有）
    if (oldIdx < oi) {
      ops.push({ tag: "delete", oldStart: oldIdx + 1, oldEnd: oi + 1, newStart: newIdx + 1, newEnd: newIdx + 1 });
    }
    // 新增的行（在新文本中有，LCS 中没有）
    if (newIdx < ni) {
      ops.push({ tag: "insert", oldStart: oi + 1, oldEnd: oi + 1, newStart: newIdx + 1, newEnd: ni + 1 });
    }
    // 相同的行
    ops.push({ tag: "equal", oldStart: oi + 1, oldEnd: oi + 2, newStart: ni + 1, newEnd: ni + 2 });
    oldIdx = oi + 1;
    newIdx = ni + 1;
  }

  // 尾部
  if (oldIdx < oldLines.length) {
    ops.push({ tag: "delete", oldStart: oldIdx + 1, oldEnd: oldLines.length + 1, newStart: newIdx + 1, newEnd: newIdx + 1 });
  }
  if (newIdx < newLines.length) {
    ops.push({ tag: "insert", oldStart: oldLines.length + 1, oldEnd: oldLines.length + 1, newStart: newIdx + 1, newEnd: newLines.length + 1 });
  }

  return ops;
}
