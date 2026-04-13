/**
 * 工程化目录/文件忽略规则
 * 即使 .gitignore 没有忽略，这些目录也不统计
 */

const IGNORED_DIRS = [
  "node_modules", "out", "dist", ".next", ".nuxt", ".output", "target", 
  "obj", "__pycache__", ".tox", ".venv", "venv", "env", ".env", ".git", 
  ".kiro", "vendor", ".cache", ".parcel-cache","generated",
];

const IGNORED_EXTENSIONS = [
  ".min.js", ".min.css", ".bundle.js", ".chunk.js",
  ".map", ".lock", ".vsix",
];

export function shouldIgnoreFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");

  // 检查路径中是否包含忽略的目录
  for (const part of parts) {
    if (IGNORED_DIRS.includes(part)) return true;
  }

  // 检查文件扩展名
  for (const ext of IGNORED_EXTENSIONS) {
    if (normalized.endsWith(ext)) return true;
  }

  return false;
}
