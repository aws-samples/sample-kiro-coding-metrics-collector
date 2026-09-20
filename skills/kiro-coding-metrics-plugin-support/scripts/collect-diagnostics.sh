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

echo "=== 3. Hook 生效位置（core.hooksPath）==="
# 企业环境常把 core.hooksPath 指向安全工具目录，hook 不在 .git/hooks 下。
# 不先确认这个，"hook 不存在"的结论会是错的。
echo "repo   core.hooksPath: $(git -C "$REPO_ROOT" config --get core.hooksPath 2>/dev/null || echo '(未设置)')"
echo "global core.hooksPath: $(git config --global --get core.hooksPath 2>/dev/null || echo '(未设置)')"
echo "system core.hooksPath: $(git config --system --get core.hooksPath 2>/dev/null || echo '(未设置)')"
EFFECTIVE_HOOKS_DIR="$(git -C "$REPO_ROOT" rev-parse --git-path hooks 2>/dev/null)"
case "$EFFECTIVE_HOOKS_DIR" in
  /*) ;;
  *) EFFECTIVE_HOOKS_DIR="$REPO_ROOT/$EFFECTIVE_HOOKS_DIR" ;;
esac
echo "实际生效 hooks 目录: $EFFECTIVE_HOOKS_DIR"
if [ -d "$EFFECTIVE_HOOKS_DIR" ]; then
  ls -la "$EFFECTIVE_HOOKS_DIR" 2>/dev/null | head -20
  for h in pre-commit post-commit; do
    if [ -f "$EFFECTIVE_HOOKS_DIR/$h" ]; then
      # 非文本 hook（第三方工具的编译产物）插件会拒绝改写并跳过安装
      echo "$h 文件类型: $(file -b "$EFFECTIVE_HOOKS_DIR/$h" 2>/dev/null)"
      echo "$h 含 git-ai-kiro marker: $(grep -c 'git-ai-kiro' "$EFFECTIVE_HOOKS_DIR/$h" 2>/dev/null | head -1)"
    fi
  done
else
  echo "(生效 hooks 目录不存在)"
fi
echo ""

echo "=== 3b. Hook 文件内容（.git/hooks 下）==="
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

echo "=== 8b. note 是否能被当前二进制解析（AI 行被算成 human 的隐蔽根因） ==="
# note 内容看起来正常但读取侧解析失败时，AI 归因会被整份丢弃、全部计入 human。
# 诱因通常是客户机上装过更新版 git-ai，它写的 note 含本版本不识别的结构。
if [ -n "$GIT_AI_DIR" ] && [ -n "$LATEST_SHA" ]; then
  GITAI_BIN="$GIT_AI_DIR/bin/git-ai"
  [ -f "$GITAI_BIN" ] || GITAI_BIN="$GIT_AI_DIR/bin/git-ai-linux"
  if [ -f "$GITAI_BIN" ]; then
    echo "--- stats stderr（关注 'could not be parsed'） ---"
    (cd "$REPO_ROOT" && "$GITAI_BIN" stats "$LATEST_SHA" --json 2>&1 >/dev/null | head -10) || true
  fi
fi
echo "--- 各 note 是由哪个 git-ai 版本写的（版本混用是诱因） ---"
git -C "$REPO_ROOT" notes --ref=ai list 2>/dev/null | awk '{print $2}' | head -40 | while read -r c; do
  git -C "$REPO_ROOT" notes --ref=ai show "$c" 2>/dev/null | grep -o '"git_ai_version": "[^"]*"'
done | sort | uniq -c
echo ""

echo "=== 8c. Kiro 1.0 会话日志（Format C 数据源） ==="
# 旧版 Kiro 写 globalStorage 下的 execution log；Kiro 1.0 改到这里。
# 客户升级 Kiro 后若插件不支持 Format C，会表现为"AI 数据突然全断"。
KIRO_SESSIONS="$HOME/.kiro/sessions"
if [ -d "$KIRO_SESSIONS" ]; then
  echo "存在: $KIRO_SESSIONS  → 数据源可能是 Format C"
  echo "--- 会话目录（跳过 cli，那是 Kiro CLI 的会话） ---"
  find "$KIRO_SESSIONS" -maxdepth 2 -name 'sess_*' -type d 2>/dev/null | grep -v '/cli/' | head -10 | while read -r sdir; do
    echo "[$sdir]"
    MJ="$sdir/messages.jsonl"
    if [ -f "$MJ" ]; then
      # 体积很关键：超上限的会话会被整份静默跳过
      ls -la "$MJ" 2>/dev/null | awk '{print "  messages.jsonl 大小:", $5, "bytes"}'
      echo "  行数: $(wc -l < "$MJ" 2>/dev/null | tr -d ' ')"
    else
      echo "  (无 messages.jsonl —— 该会话不会被采集)"
    fi
    # workspacePaths 决定归属，Windows 上盘符大小写/分隔符不一致会导致匹配失败
    if [ -f "$sdir/session.json" ]; then
      python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
print('  workspacePaths:', d.get('workspacePaths'))
print('  lastModifiedAt:', d.get('lastModifiedAt'))
" "$sdir/session.json" 2>/dev/null || echo "  (session.json 解析失败)"
    else
      echo "  (无 session.json —— 无法判定归属哪个 workspace)"
    fi
  done
else
  echo "(不存在 $KIRO_SESSIONS → 数据源应为旧版 execution log / Format A/B)"
fi
echo ""
echo "--- 旧版 execution log 目录（Format A/B） ---"
case "$(uname -s)" in
  Darwin*) EXEC_LOG_ROOT="$HOME/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent" ;;
  *)       EXEC_LOG_ROOT="$HOME/.config/Kiro/User/globalStorage/kiro.kiroagent" ;;
esac
if [ -d "$EXEC_LOG_ROOT" ]; then
  find "$EXEC_LOG_ROOT" -maxdepth 2 -type d 2>/dev/null | head -10
else
  echo "(不存在)"
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
