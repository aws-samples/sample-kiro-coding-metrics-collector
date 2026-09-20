/**
 * 把核心源码复制到 kiro-plugin/support-sources/，让 VSIX 携带源码供客户支持时分析。
 * 与 skills/kiro-coding-metrics-plugin-support/references/code-lookup.md 的清单保持同步。
 *
 * 由 package.json 的 `vscode:prepublish` 自动调用，因此任何 `vsce package`
 * （含带 --target 的变体）都会重新生成，不会漏带。
 *
 * 取代原先的 copy-support-sources.sh / copy-support-sources.ps1：两份脚本内容等价、
 * 需人工保持同步，是重复来源。Node 版单份即可跨平台，与 copy-binary.js /
 * copy-hooks.js 的做法一致。
 *
 * 注意：support-sources/ 是生成产物，已被 .gitignore 忽略。它是 kiro-plugin/src 与
 * git-ai-src/src 的副本 —— 修改源码请改这两处正本，不要改 support-sources 下的副本。
 */

const fs = require("node:fs");
const path = require("node:path");

const pluginRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(pluginRoot, "..");
const dest = path.join(pluginRoot, "support-sources");

/** TS 插件核心源码（code-lookup.md 模块 1/2/3） */
const TS_FILES = [
  "sessionLogWatcher.ts",
  "sessionLogParser.ts",
  "sessionLogScanner.ts",
  "checkpointPayload.ts",
  "repoRouter.ts",
  "workspacePathEncoder.ts",
  "gitUtils.ts",
  "checkpoint.ts",
  "apiConfig.ts",
  "userSync.ts",
  "qClientWatcher.ts",
  "extension.ts",
  "commitWatcher.ts",
  "statsUploader.ts",
];

/** git-ai Rust 核心源码（code-lookup.md 模块 4），路径相对 git-ai-src/ */
const RUST_FILES = [
  "src/commands/git_ai_handlers.rs",
  "src/authorship/post_commit.rs",
  "src/authorship/rebase_authorship.rs",
  "src/authorship/virtual_attribution.rs",
  "src/authorship/attribution_tracker.rs",
  "src/git/rewrite_log.rs",
];

const README = `# Support Sources

这个目录包含插件核心模块的源码副本，用于客户支持时的问题分析。

**这是生成产物，不要在此处修改代码。** 正本位于：

- \`kiro-plugin/src/\` — TypeScript 插件源码
- \`git-ai-src/src/\` — git-ai Rust 后端

本目录由 \`scripts/copy-support-sources.js\` 在打包时（\`vscode:prepublish\`）自动重建，
任何在此处的修改都会被覆盖。目录本身已被 \`.gitignore\` 忽略。

## 用途

- 客户机上插件安装后，这些文件位于 \`<extension-dir>/support-sources/\`
- 支持工程师可通过 \`kiro-coding-metrics-plugin-support\` skill 直接读取
- 不需要客户提供源码，也不需要工程师从 GitHub 拉取

## 包含范围

与 \`skills/kiro-coding-metrics-plugin-support/references/code-lookup.md\` 一致。
不包含 dashboard 服务端代码（不属于客户机插件）。
`;

function copyInto(srcAbs, destRelDir) {
  if (!fs.existsSync(srcAbs)) return false;
  const destDir = path.join(dest, destRelDir);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(srcAbs, path.join(destDir, path.basename(srcAbs)));
  return true;
}

console.log(`Copying core source files to ${dest}`);
fs.rmSync(dest, { recursive: true, force: true });

const copied = [];
const missing = [];

for (const f of TS_FILES) {
  const src = path.join(pluginRoot, "src", f);
  if (copyInto(src, path.join("kiro-plugin", "src"))) {
    copied.push(`kiro-plugin/src/${f}`);
  } else {
    missing.push(`kiro-plugin/src/${f}`);
  }
}

for (const rel of RUST_FILES) {
  const src = path.join(projectRoot, "git-ai-src", rel);
  if (copyInto(src, path.join("git-ai-src", path.dirname(rel)))) {
    copied.push(`git-ai-src/${rel}`);
  } else {
    missing.push(`git-ai-src/${rel}`);
  }
}

fs.writeFileSync(path.join(dest, "README.md"), README, "utf-8");

console.log("");
console.log(`Copied ${copied.length} source files to ${dest}`);
for (const f of copied) console.log(`  ${f}`);

if (missing.length > 0) {
  // 清单里列了但磁盘上没有 —— 通常意味着源码被重命名/移动而清单没跟着改。
  // 不让打包失败（缺一份支持用副本不该阻断发版），但必须显式告警。
  console.warn("");
  console.warn(
    `WARNING: ${missing.length} file(s) in the manifest were not found; ` +
      `update scripts/copy-support-sources.js if the sources moved:`
  );
  for (const f of missing) console.warn(`  ${f}`);
}
