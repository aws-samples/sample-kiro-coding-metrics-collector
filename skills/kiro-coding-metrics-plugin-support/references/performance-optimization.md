# post-commit Hook 性能优化与故障定位

针对客户报告"git commit 卡很久（10s+ 到 90s+）"、"Kiro 操作后 IDE 卡顿"、"hook 进程堆积"等性能类症状的方法论与已落地优化清单。

---

## 1. 症状索引

| 症状 | 优先排查方向 | 对应章节 |
|------|------------|---------|
| `git commit` 命令在终端等待数十秒才返回 | hook 是否后台脱离 | §3 setsid 后台化 |
| `git commit` 完成后下一次 commit 立刻报错 / 数据丢失 | 多 hook 并发写冲突 | §4 flock 互斥锁 |
| 同一仓库 commit 时长 D 盘 ≫ C 盘（数倍差距） | Windows 慢盘 + Defender | §2 慢盘环境识别 |
| 任务管理器一堆 git-ai.exe 占用内存 | 进程堆积 | §5 进程治理 |
| 多对话框并发触发 AI 编辑后 IDE 严重卡顿 | TS 端 spawn 风暴 | §5 进程治理 |
| 客户报"hook 跑了 90 秒"，但日志显示 Rust 内部只占 50s | shell 端 fork 风暴 | §6 fork 风暴 |
| 升级新版本后部分客户变慢 | 反向优化（cache 预热被破坏） | §7 反优化教训 |

---

## 2. Windows 慢盘环境识别

### 2.1 触发条件

只要客户机同时满足以下，就要把"慢盘"列为高优先级嫌疑：

- 仓库放在 **D: / E: / F: 等非系统盘**（机械盘、USB 移动硬盘、网络盘、加密盘最严重）
- **Windows Defender 实时保护未排除** 仓库目录或 git-ai.exe
- 仓库 working tree 文件数 > 5,000，或 `.git/objects` > 500 MB
- 客户使用企业 EDR / DLP 软件（CrowdStrike、Carbon Black、Symantec 等）

### 2.2 快速验证

```powershell
# 1) 看仓库所在卷的类型
Get-Volume -DriveLetter D | Select-Object DriveType, FileSystemType, Size

# 2) 看 Defender 排除项
Get-MpPreference | Select-Object -ExpandProperty ExclusionPath

# 3) 临时绕过 Defender 实测对比（管理员）
# Add-MpPreference -ExclusionPath "D:\repo-path"
# Add-MpPreference -ExclusionProcess "git-ai.exe"
# 跑一次 commit 对比时间。结束后用 Remove-MpPreference 清理。

# 4) 看 git diff 冷启动时间（最直观）
Measure-Command { git -C D:\repo diff --shortstat HEAD~1 HEAD }
Measure-Command { git -C D:\repo diff --shortstat HEAD~1 HEAD }   # 第二次（warm cache）
```

**判定**：
- 第二次明显 < 第一次 → **OS page cache 预热效应显著**，本仓库 IO 受 Defender / 慢盘影响重
- 两次都很慢 → 盘本身慢（机械盘 / 网络盘）

### 2.3 处置原则

- 优先：**让客户做 Defender 排除**（仓库目录 + git-ai.exe），多数客户能立刻获得 50%+ 提升
- 其次：客户拒绝 Defender 排除时，引导走 §3 setsid 后台化（用户感知降到 < 5s）
- 兜底：把仓库迁到 SSD / C 盘

---

## 3. setsid 后台化（让 git commit 立即返回）

### 3.1 改造目的

hook 内部仍按原顺序同步执行 70s（写 git note → emit stats/diff → payload → curl），**只让 `git commit` 命令几秒就返回到 shell 提示符**。

- 数据完整性：✅ **不变**（写入时序与 hook 内逻辑完全一致）
- 用户感知：从 70s → < 3-5s
- 风险点：`< 70s 内连续 commit` 会出现 hook 并发，必须配 §4 flock 互斥

### 3.2 实现要点（位于 `kiro-plugin/src/hooks/post-commit.sh.tpl`）

把 hook body 整体函数化，再用三档启动按"detach 强度"递减：

```sh
# === setsid 完全脱离 git 父进程 ===
_gitai_kiro_body() {
  COMMIT_SHA=$(git rev-parse HEAD 2>/dev/null)
  if [ -z "$COMMIT_SHA" ]; then return 0; fi
  ...原有所有 hook 逻辑...
}

# 三档启动：setsid -f 优先 → nohup 次选 → (...) & 兜底
if command -v setsid >/dev/null 2>&1; then
  setsid -f bash -c "$(declare -f _gitai_kiro_body); _gitai_kiro_body" </dev/null >/dev/null 2>&1
elif command -v nohup >/dev/null 2>&1; then
  nohup bash -c "$(declare -f _gitai_kiro_body); _gitai_kiro_body" </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
else
  ( _gitai_kiro_body ) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi
```

**注意**：

- `setsid -f` 是 util-linux 的标准选项，Git for Windows 4.x+ 自带
- `bash -c "$(declare -f f); f"` 是把函数定义传到子 bash 的 trick，依赖 bash builtin（Git Bash 的 `sh` 实际就是 bash）
- 函数体内所有 `exit 0` 必须改成 `return 0`，否则会退出整个 bash 进程导致 fallback 路径异常
- 所有 IO 重定向 `</dev/null >/dev/null 2>&1` 必须保留，否则 git 会等待 stdout/stderr 关闭

### 3.3 验证方法

让客户跑一次 commit 后看：

```bash
# 1) git commit 命令何时返回？
time git commit --allow-empty -m "test setsid"

# 2) 日志里是否出现这两条标记
grep "acquired post-commit lock" .git/ai/logs/post-commit-*.log
grep "===== post-commit hook finished =====" .git/ai/logs/post-commit-*.log
```

| 实测结果 | 含义 |
|---|---|
| `time` < 5s | ✅ setsid 生效 |
| `time` ≈ 70s | ⚠️ Windows Git Bash 下 setsid 未真正脱离，需进一步定位 |

---

## 4. flock 互斥锁（防并发写冲突）

### 4.1 为什么需要

setsid 让 git commit 立即返回后，用户可能在前一次 hook 还没跑完时（< 70s 内）就发起第二次 commit。两个 hook 进程会**并发写**：

- `git update-ref refs/notes/ai`（git 内部锁，会冲突）
- `<repo>/.git/ai/working_logs/<sha>/checkpoints.jsonl`（追加写竞态）
- `<repo>/.git/ai/last_upload_payload.json`（小行 append 通常安全，但跨平台无保证）

### 4.2 实现要点

在 hook started 之后立即抢锁：

```sh
POST_COMMIT_LOCK="$GIT_COMMON_DIR/ai/post-commit.lock"
mkdir -p "$GIT_COMMON_DIR/ai" 2>/dev/null
if command -v flock >/dev/null 2>&1; then
  exec 200>"$POST_COMMIT_LOCK" 2>/dev/null
  if ! flock -n 200; then
    _log "another post-commit hook is running, skip to avoid concurrent write"
    _log "===== post-commit hook finished (skipped due to lock) ====="
    return 0
  fi
  _log "acquired post-commit lock fd=200 path=$POST_COMMIT_LOCK"
else
  _log "flock not available, skipping mutex (concurrent commits may race)"
fi
```

**设计取舍**：

- 用 `flock -n`（非阻塞）而不是阻塞等：连续快速 commit 时第二次直接 skip 上报，避免拖慢真正等待的客户
- skip 仅丢上报，**不影响 git 本身**（commit 已经完成）
- 锁文件放 `$GIT_COMMON_DIR/ai/`（worktree-safe），避免多 worktree 锁互相干扰

### 4.3 客户报"我连续提交后第二次没数据"

预期行为：第二次 commit 的日志里有：

```
another post-commit hook is running, skip to avoid concurrent write
===== post-commit hook finished (skipped due to lock) =====
```

属正常保护，不是 bug。让客户隔 > 70s 再 commit 即可。

### 4.4 配合 §5：删除 `taskkill //F //IM git-ai.exe`

setsid 后多 hook 可能并存，**全局名匹配清理会误杀其他还在跑的 hook 的 git-ai 进程**。post-commit hook 末尾该行必须删除，让 OS 自然回收。

---

## 5. 进程治理（堆积、串扰）

### 5.1 三类进程问题

| 现象 | 根因 | 修复点 |
|------|------|------|
| 任务管理器一堆 git-ai.exe | hook 末尾 taskkill 误杀 / spawn 失败累积 / 客户在多 commit 期间未清理 | 删除全局 taskkill；后端加 fs2 文件锁 |
| 多对话框并发触发 AI 编辑 → IDE 严重卡顿 | TS 端对同一仓库重复 spawn git-ai checkpoint | 前端 per-repo 队列调度 |
| `checkpoints.jsonl` 内容损坏（JSON 解析失败） | 多进程并发追加写，缺 advisory lock | 后端 `repo_storage.rs` fs2 advisory `.checkpoints.lock` |

### 5.2 双层防护（已落地）

- **前端** `kiro-plugin/src/checkpoint.ts`：按 `cwd` 路径维护 per-repo 队列，drain 机制防重复 spawn
- **后端** `git-ai-src/src/git/repo_storage.rs`：`with_checkpoint_lock` 包裹 append，依赖 `fs2` 的 advisory file lock

### 5.3 客户侧诊断命令

```powershell
# 看是否有堆积
Get-Process git-ai -ErrorAction SilentlyContinue | Select-Object Id, StartTime, CPU, WorkingSet64

# 看锁文件状态
Get-ChildItem "<repo>\.git\ai\.checkpoints.lock", "<repo>\.git\ai\post-commit.lock"
```

---

## 6. Windows Git Bash fork 风暴

### 6.1 现象

Windows 下每次 `printf | sed`、`$( ... )`、`$(date ...)` 等子进程调用都要付 ~1-1.5s 的 fork-exec 代价（Linux 是几毫秒）。一段长 hook 下来累积 10-30s 全在 fork 上。

### 6.2 已落地优化（B+C 改造）

- **B**：Rust 端把 stats / diff / final-stats / meta 一次性算好，通过 stdout 多行 prefix（`GITAI-STATS:` / `GITAI-DIFF:` / `GITAI-FINAL-STATS:` / `GITAI-META-USER-ID:`）输出
- **C**：shell FAST PATH 用单次 `EMIT_OUT=$(... 2>/dev/null)` 抓全量，再用 4 个 `sed -n 's/^GITAI-X://p'` 切片（替代原来 3 次 git-ai 冷启动 + 多次 awk）
- **emit 三合一**：post-commit / stats / diff 由 3 次冷启动合并为 1 次（每次冷启动约 600ms）

### 6.3 异步化（H+J）

进一步把 hook 主流程分两段：

- **前台同步段**：git-ai post-commit + stats/diff 解析（70s 中的 ~50s 数据写入）
- **后台异步段**：payload 拼接 + curl 上报 + cleaning logs（~14s）

异步化模板：

```sh
{
  ... 后台工作 ...
} </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true
```

实测节省 ≈ 14s（D 盘 cmp 仓库 84s → 70s）。

---

## 7. 反优化教训（写在最前面避免重蹈覆辙）

### 7.1 PrebuiltDiffData 反优化案例

**改造意图**：把 `emit_execute_diff` 已经解析好的 `DiffJson` 复用给 `stats_for_commit_stats`，让 stats 跳过 2 次内部 `git diff`，预期节省 4s。

**自检环境（C 盘 SSD）**：emit_stats 阶段从 1524ms → 901ms，**-41% ✅**

**客户慢盘环境（D 盘 + Defender）**：execute_diff 从 8s → 14s，total **+6s ❌**

**根因**：

- 原顺序 `stats → diff` 让 stats 内部的两次 `git diff` 把对象库 / pack 文件**热加载到 OS page cache**
- 第三次 `git diff`（在 execute_diff 中）跑在 hot cache 上极快
- 改成 `diff → stats`（diff 复用）后，第一次 `git diff` 是 cold cache，**Defender 实时扫描每个 pack 文件**，冷启动暴涨
- stats 复用计算虽然省了 2 次 git 调用，但失去了 cache warming 的隐含价值，净亏

**教训**：

1. **Windows 慢盘下"重复 git 调用"未必是浪费**，可能隐含 OS page cache 预热价值
2. **C 盘 SSD 自检通过 ≠ D 盘 + Defender 客户环境通过**
3. 涉及 git diff 顺序的优化必须在客户慢盘环境实测，不能只看自检结果
4. 该模式已在源码里加 `#[allow(dead_code)]` 保留 API + 长注释警示

### 7.2 其他类似陷阱

- 把 `for f in $(ls ...)` 改成 `find ... -exec`：Windows 下 find 进程启动开销可能更大
- 把 shell `awk` 改成 `python -c`：python 冷启动 800ms，比 awk 多 5 倍
- 给 git-ai 加 mmap 预读：D 盘 mmap 受 Defender 阻塞反而更慢

---

## 8. GITAI-TIMING 阶段计时协议

### 8.1 协议

git-ai 在 `--emit-stats-and-diff` 模式下通过 stdout 输出 11 个阶段的计时（基于 `std::time::Instant`），格式：

```
GITAI-TIMING:<stage>=<ms>
```

阶段（按出现顺序）：

1. `find_repository`
2. `show_authorship_note_check`
3. `auth_parent_resolve`
4. `auth_pre_commit_checkpoint`
5. `auth_write_note`（最易成为瓶颈，单次可达 21s+）
6. `emit_effective_ignore`
7. `emit_stats_for_commit_stats`
8. `emit_execute_diff`
9. `emit_meta_fields`
10. `emit_final_stats_and_invalid`
11. `total`

### 8.2 客户侧采集方法

在 hook 中已经会把 git-ai stdout 的 GITAI-* 全行抓到 EMIT_OUT。直接：

```bash
printf '%s\n' "$EMIT_OUT" | grep '^GITAI-TIMING:'
```

或让客户把 `<repo>/.git/ai/logs/post-commit-YYYY-MM-DD.log` 整段发来，里面会有完整阶段分布。

### 8.3 用阶段计时定位瓶颈

| 主要瓶颈阶段 | 可能根因 | 处置 |
|----|----|----|
| `find_repository` > 1s | 仓库父目录链上挂载点 / 网络盘 / 大量 .git 嵌套 | 让客户检查 git rev-parse --show-toplevel 时间 |
| `auth_write_note` > 10s | 内含多次 git diff + git update-ref，慢盘下放大 | 引导走 §2 Defender 排除 / §3 setsid |
| `emit_stats_for_commit_stats` > 5s | stats 内部 2 次 git diff，cold cache 主导 | 同上，避免改 diff 顺序 |
| `emit_execute_diff` > 10s | 大 diff（万行级别）+ 慢盘 | 检查是否大文件 / minified asset，必要时加 ignore_pattern |
| `total` 远大于各阶段之和 | shell 端 fork 风暴 / curl 网络慢 | 走 §6 fork 风暴 / §3 异步化 |

---

## 9. 优化效果时间线（D 盘 cmp 仓库实测）

记录改造前后的客户实测对比，便于诊断时判断"客户当前在哪个版本下"：

| 版本 | 改动 | git commit 命令耗时 | hook 内部总耗时 |
|------|------|--------------------|----------------|
| < 0.2.5 | 原始 3 次冷启动 + 全同步 | ~110s | ~110s |
| 0.2.5 | 杀残留进程 + INVALID_EXTS 修复 | ~95s | ~95s |
| 0.2.6 | B+C 改造（Rust 前置 + FAST PATH） | 92s | 92s |
| 0.2.7 | fork 风暴优化 | 84s | 84s |
| 0.2.8 | H+J 异步化（payload+HTTP / cleaning logs 后台） | 70s | 70s |
| **0.2.9** | **setsid 完全脱离 + flock 互斥 + 删全局 taskkill** | **< 5s** | 70s（不变，纯感知优化） |

**关键判定**：客户报"git commit 卡 70s+" → 看 `package.json` 版本是否 ≥ 0.2.9，否则建议升级。

---

## 10. 排查命令速查

```bash
# 1) 看 hook 是否是新版（含 setsid 启动逻辑）
grep -E "setsid -f|_gitai_kiro_body|flock -n 200" <repo>/.git/hooks/post-commit
# 期望命中 3 处以上

# 2) 看 hook 实际执行时长（最近一次）
ls -la <repo>/.git/ai/logs/post-commit-*.log | tail -1
# 看文件首尾时间戳差

# 3) 看 GITAI-TIMING 各阶段
grep 'GITAI-TIMING:' <repo>/.git/ai/logs/post-commit-*.log | tail -20

# 4) 看 flock 是否生效
grep 'acquired post-commit lock\|skipped due to lock' <repo>/.git/ai/logs/post-commit-*.log

# 5) 看是否有 git-ai 进程堆积
# Windows
tasklist | findstr git-ai
# Linux/macOS
ps aux | grep -E 'git-ai( |$)' | grep -v grep

# 6) 看 Defender 排除（PowerShell）
Get-MpPreference | Select-Object -ExpandProperty ExclusionPath
Get-MpPreference | Select-Object -ExpandProperty ExclusionProcess
```

---

## 11. 反模式（性能优化场景）

- ❌ 没在客户慢盘环境实测就上线（C 盘自检 -41%，D 盘实测 +6s）
- ❌ 把 git diff 顺序当成"无副作用"改造（隐含 cache warming 价值）
- ❌ 用全局名匹配 taskkill 清理 git-ai（会误杀并发 hook 的进程）
- ❌ setsid 后不加 flock 互斥（连续快速 commit 会数据冲突）
- ❌ 把 hook body 写成 `(...) &` 然后期待 setsid 也能脱离（必须显式 `setsid -f bash -c ...`）
- ❌ 函数化 hook body 后忘了把 `exit 0` 改成 `return 0`（会让 fallback 路径异常退出）
- ❌ 把 cleaning logs / curl 等纯 IO 操作放在前台（必然贡献 10s+ 用户感知）
- ❌ 给客户一句"升级到最新版"就完事——必须先识别瓶颈在哪一段，否则客户可能反报"升级后还是慢"
