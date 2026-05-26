#!/bin/sh
# git-ai-kiro 插件诊断信息收集脚本（macOS / Linux）
# 用法: cd <git-repo> && sh collect-diagnostics.sh > diagnostics.txt 2>&1
# 输出到 stdout，重定向到文件后发给支持人员
#
# ⚠️ 该脚本仅读取，不会修改任何文件

set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
echo "==========================================="
echo "git-ai-kiro 诊断信息收集"
echo "==========================================="
echo "时间: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "REPO_ROOT: $REPO_ROOT"
echo "OS: $(uname -s) $(uname -r) $(uname -m)"
echo ""

echo "=== 1. Git 信息 ==="
git -C "$REPO_ROOT" --version
git -C "$REPO_ROOT" log --oneline -5
echo ""
echo "--- reflog（最近 10 条） ---"
git -C "$REPO_ROOT" reflog -10
echo ""

echo "=== 2. 插件安装目录 ==="
KIRO_EXT_DIR="$HOME/.kiro/extensions"
if [ -d "$KIRO_EXT_DIR" ]; then
  ls -la "$KIRO_EXT_DIR" | grep -i "git-ai" || echo "(未找到 git-ai 插件目录)"
  GIT_AI_DIR=$(ls -d "$KIRO_EXT_DIR"/git-ai* 2>/dev/null | tail -1)
  if [ -n "$GIT_AI_DIR" ]; then
    echo ""
    echo "--- 插件版本 ---"
    cat "$GIT_AI_DIR/package.json" 2>/dev/null | grep -E '"name"|"version"' | head -3
    echo ""
    echo "--- bin 目录 ---"
    ls -la "$GIT_AI_DIR/bin/" 2>/dev/null
  fi
else
  echo "(未找到 ~/.kiro/extensions)"
fi
echo ""

echo "=== 3. Hook 文件 ==="
echo "--- pre-commit ---"
if [ -f "$REPO_ROOT/.git/hooks/pre-commit" ]; then
  ls -la "$REPO_ROOT/.git/hooks/pre-commit"
  echo "--- 内容 ---"
  cat "$REPO_ROOT/.git/hooks/pre-commit"
else
  echo "(不存在)"
fi
echo ""
echo "--- post-commit ---"
if [ -f "$REPO_ROOT/.git/hooks/post-commit" ]; then
  ls -la "$REPO_ROOT/.git/hooks/post-commit"
  echo "--- 内容（前 200 行） ---"
  head -200 "$REPO_ROOT/.git/hooks/post-commit"
else
  echo "(不存在)"
fi
echo ""

echo "=== 4. .git/ai 目录 ==="
if [ -d "$REPO_ROOT/.git/ai" ]; then
  ls -la "$REPO_ROOT/.git/ai"
  echo ""
  echo "--- working_logs 目录 ---"
  ls -la "$REPO_ROOT/.git/ai/working_logs/" 2>/dev/null | head -20
else
  echo "(不存在)"
fi
echo ""

echo "=== 5. 最近 20 条 stats / userSync 上报记录 ==="
PAYLOAD_FILE="$REPO_ROOT/.git/ai/last_upload_payload.json"
if [ -f "$PAYLOAD_FILE" ]; then
  echo "--- 文件大小 ---"
  ls -la "$PAYLOAD_FILE"
  echo ""
  echo "--- 最近 20 条记录 ---"
  tail -c 200000 "$PAYLOAD_FILE" 2>/dev/null | grep -oE '\[(stats|userSync)\] \[[^]]*\] \{[^}]*\}' | tail -20
else
  echo "(不存在)"
fi
echo ""

echo "=== 6. post_commit_debug.log（最后 5 个 commit 的 debug 信息） ==="
DEBUG_LOG="$REPO_ROOT/.git/ai/post_commit_debug.log"
if [ -f "$DEBUG_LOG" ]; then
  echo "--- 文件大小 ---"
  ls -la "$DEBUG_LOG"
  echo ""
  # 提取最后 5 个 "--- timestamp ---" 块
  awk '/^--- [0-9]+ ---/{n++; if(n>5) exit} {print}' "$DEBUG_LOG" 2>/dev/null | tail -200
else
  echo "(不存在)"
fi
echo ""

echo "=== 7. Workspace 中的 git repo 清单 ==="
WORKSPACE_PARENT=$(dirname "$REPO_ROOT")
echo "搜索 $WORKSPACE_PARENT 下的 git repo（最多 3 层）"
find "$WORKSPACE_PARENT" -maxdepth 3 -type d -name ".git" 2>/dev/null | sed 's|/.git$||' | head -30
echo ""

echo "=== 8. 最近一次 commit 的 git note ==="
LATEST_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)
if [ -n "$LATEST_SHA" ]; then
  echo "Commit: $LATEST_SHA"
  git -C "$REPO_ROOT" notes --ref=ai show "$LATEST_SHA" 2>/dev/null || echo "(无 ai note)"
fi
echo ""

echo "=== 9. 最近的 q-client.log（如有） ==="
case "$(uname -s)" in
  Darwin*)
    QLOG_DIR="$HOME/Library/Application Support/Kiro/logs"
    ;;
  *)
    QLOG_DIR="$HOME/.config/Kiro/logs"
    ;;
esac
if [ -d "$QLOG_DIR" ]; then
  LATEST_QLOG=$(find "$QLOG_DIR" -name "q-client.log" 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
  if [ -n "$LATEST_QLOG" ]; then
    echo "Log file: $LATEST_QLOG"
    echo "--- 最后 30 行 ---"
    tail -30 "$LATEST_QLOG"
  fi
fi
echo ""

echo "=== 10. Curl 可用性 ==="
which curl 2>/dev/null && curl --version 2>&1 | head -1
if [ -n "$GIT_AI_DIR" ] && [ -f "$GIT_AI_DIR/bin/curl.exe" ]; then
  echo "插件 bundled curl.exe: $GIT_AI_DIR/bin/curl.exe"
  ls -la "$GIT_AI_DIR/bin/curl.exe"
fi
echo ""

echo "==========================================="
echo "诊断信息收集完成"
echo "==========================================="
