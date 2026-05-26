#!/bin/sh
# 把核心源码复制到 kiro-pugin/support-sources/ 下，让 VSIX 携带源码用于客户支持时分析
# 与 skills/kiro-plugin-customer-support/references/code-lookup.md 列出的文件保持同步
#
# 在 vsce package 之前运行

set -e

SCRIPT_DIR=$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")
PLUGIN_ROOT="$SCRIPT_DIR/.."
PROJECT_ROOT="$PLUGIN_ROOT/.."
DEST="$PLUGIN_ROOT/support-sources"

echo "Copying core source files to $DEST"

rm -rf "$DEST"
mkdir -p "$DEST/kiro-pugin/src"
mkdir -p "$DEST/git-ai-src/src/commands"
mkdir -p "$DEST/git-ai-src/src/authorship"
mkdir -p "$DEST/git-ai-src/src/git"

# TS 插件核心源码（与 code-lookup.md 模块 1/2/3 一致）
for f in \
  sessionLogWatcher.ts \
  sessionLogParser.ts \
  sessionLogScanner.ts \
  checkpointPayload.ts \
  repoRouter.ts \
  workspacePathEncoder.ts \
  gitUtils.ts \
  checkpoint.ts \
  apiConfig.ts \
  userSync.ts \
  qClientWatcher.ts \
  extension.ts \
; do
  if [ -f "$PLUGIN_ROOT/src/$f" ]; then
    cp "$PLUGIN_ROOT/src/$f" "$DEST/kiro-pugin/src/$f"
  fi
done

# git-ai Rust 核心源码（与 code-lookup.md 模块 4 一致）
[ -f "$PROJECT_ROOT/git-ai-src/src/commands/git_ai_handlers.rs" ] && \
  cp "$PROJECT_ROOT/git-ai-src/src/commands/git_ai_handlers.rs" "$DEST/git-ai-src/src/commands/"

for f in post_commit.rs rebase_authorship.rs virtual_attribution.rs attribution_tracker.rs; do
  [ -f "$PROJECT_ROOT/git-ai-src/src/authorship/$f" ] && \
    cp "$PROJECT_ROOT/git-ai-src/src/authorship/$f" "$DEST/git-ai-src/src/authorship/"
done

[ -f "$PROJECT_ROOT/git-ai-src/src/git/rewrite_log.rs" ] && \
  cp "$PROJECT_ROOT/git-ai-src/src/git/rewrite_log.rs" "$DEST/git-ai-src/src/git/"

# 加 README 说明这些文件的用途
cat > "$DEST/README.md" <<'EOF'
# Support Sources

这个目录包含插件核心模块的源码副本，用于客户支持时的问题分析。

打包时由 `scripts/copy-support-sources.sh` 自动从主项目复制，与
`skills/kiro-plugin-customer-support/references/code-lookup.md` 列出的文件保持一致。

## 用途

- 客户机上插件安装后，这些文件位于 `<extension-dir>/support-sources/`
- 支持工程师可通过 `kiro-plugin-customer-support` skill 直接读取
- 不需要客户提供源码，也不需要工程师从 GitHub 拉取

## 包含范围

- `kiro-pugin/src/` — TypeScript 插件源码（SessionLogWatcher / Hook / userSync 等）
- `git-ai-src/src/` — git-ai Rust 后端核心模块

不包含 dashboard 服务端代码（不属于客户机插件）。

## 与代码同步

如修改了核心源码（如 `sessionLogWatcher.ts`），重新运行
`sh scripts/copy-support-sources.sh` 后再打包 VSIX。
`package.json` 中的 `package:local` / 打包流程会自动调用。
EOF

# 统计复制的文件
echo ""
COUNT=$(find "$DEST" -type f \( -name "*.ts" -o -name "*.rs" \) | wc -l | tr -d ' ')
echo "Copied $COUNT source files to $DEST"
find "$DEST" -type f \( -name "*.ts" -o -name "*.rs" \) | sed "s|$DEST/||"
