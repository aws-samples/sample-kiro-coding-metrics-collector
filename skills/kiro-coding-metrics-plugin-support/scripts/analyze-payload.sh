#!/bin/sh
# 分析 last_upload_payload.json 中的上报趋势
# 用法: sh analyze-payload.sh <repo-root>

REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
PAYLOAD="$REPO_ROOT/.git/ai/last_upload_payload.json"

if [ ! -f "$PAYLOAD" ]; then
  echo "(文件不存在: $PAYLOAD)"
  exit 1
fi

echo "==========================================="
echo "Payload 分析: $PAYLOAD"
echo "文件大小: $(wc -c < "$PAYLOAD") bytes"
echo "==========================================="
echo ""

# 提取所有 stats 记录
STATS_LINES=$(grep -oE '\[stats\] \[[^]]*\] \{[^}]*\}' "$PAYLOAD")
USER_SYNC_LINES=$(grep -oE '\[userSync\] \[[^]]*\] \{[^}]*\}' "$PAYLOAD")

STATS_COUNT=$(echo "$STATS_LINES" | grep -c '^' 2>/dev/null || echo 0)
USERSYNC_COUNT=$(echo "$USER_SYNC_LINES" | grep -c '^' 2>/dev/null || echo 0)

echo "=== 总计 ==="
echo "stats 上报: $STATS_COUNT 条"
echo "userSync 上报: $USERSYNC_COUNT 条"
echo ""

echo "=== 异常 stats（ai_additions=0 且 git_diff_added_lines>0）==="
echo "$STATS_LINES" | grep -E '"ai_additions":0,' | grep -vE '"git_diff_added_lines":0' | head -10
echo ""

echo "=== ai_additions 数值分布 ==="
echo "$STATS_LINES" | grep -oE '"ai_additions":[0-9]+' | sort | uniq -c | sort -rn | head -20
echo ""

echo "=== 最近 10 条 stats（按时间）==="
echo "$STATS_LINES" | tail -10 | while IFS= read -r line; do
  TS=$(echo "$line" | grep -oE '\[20[0-9]{2}-[0-9]{2}-[0-9]{2}T[^]]*\]' | head -1)
  SHA=$(echo "$line" | grep -oE '"commit_sha":"[a-f0-9]{8}' | sed 's/"commit_sha":"//')
  AI=$(echo "$line" | grep -oE '"ai_additions":[0-9]+' | grep -oE '[0-9]+')
  HU=$(echo "$line" | grep -oE '"human_additions":[0-9]+' | grep -oE '[0-9]+')
  GIT=$(echo "$line" | grep -oE '"git_diff_added_lines":[0-9]+' | grep -oE '[0-9]+')
  printf "%-30s sha=%s ai=%s human=%s git_added=%s\n" "$TS" "$SHA" "$AI" "$HU" "$GIT"
done
echo ""

echo "=== 最近 5 条 userSync ==="
echo "$USER_SYNC_LINES" | tail -5
echo ""

echo "=== 异常 amend 检测（同一 commit_sha 多次出现 + ai_additions 为 0）==="
echo "$STATS_LINES" | grep -oE '"commit_sha":"[a-f0-9]+","[^}]*"ai_additions":0' | sort | uniq -c | sort -rn | head -5
