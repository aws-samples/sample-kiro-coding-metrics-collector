---
name: kiro-coding-metrics-plugin-support
description: Diagnose git-ai-kiro plugin issues reported by customers. Use when a user reports that AI/human attribution stats are wrong, post-commit upload fails, hooks don't run, or anything stops working in the plugin. Determines whether the root cause is the customer's environment (network/path/permission/config) or a code bug (escalate to developers).
compatibility: Requires git, curl, sh, and access to GitHub raw content for source code lookups.
metadata:
  version: "3.4.0"
  github_source: "https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock"
---

# git-ai-kiro 插件问题诊断方法论

## 这个 skill 的目的

把**症状**精准定位到两类根因之一：

| 类型 | 处理方式 |
|------|---------|
| **环境/配置问题** | 给用户具体修复步骤，本地解决 |
| **代码 bug** | 收集证据链，移交开发者修复 |

假设客户已升级到最新版插件，所以**不要**预设这是某个已知 bug——按方法论从头分析。

---

## 核心方法论

### 原则 1：证据先行，禁止猜测

**坏例子**："这看起来是 amend 的问题，可能是 `ORIG_HEAD` 不对。"
**好例子**："看 `last_upload_payload.json` 中 commit X 的 `ai_additions=0`，看 reflog 确认这是 amend，看 git-ai note 确认 `prompts: {}` 为空——证据链完整指向 amend 路径。"

**强制要求**：
- 任何结论必须能引用具体日志/文件内容
- 用户说"X 不工作"时，**先读证据再问问题**
- 不要复述客户的猜测当作分析

### 原则 2：流水线端到端追踪

插件是一条多级流水线，问题总是出在某一级。**从输出反向追踪**到第一个数据丢失/错误的地方：

```
[阶段 0]  Kiro IDE AI 编辑
            ↓ 写入 execution log
[阶段 1]  SessionLogWatcher 监听 + 解析
            ↓ groupActionsByRepo
[阶段 2]  按 repo 分组 + 路径转换
            ↓ buildCheckpointPayload
[阶段 3]  调 git-ai checkpoint agent-v1
            ↓ 写入 working_logs/<base_sha>/
[阶段 4]  用户 git commit 触发 post-commit hook
            ↓ git-ai post-commit
[阶段 5]  生成 git note + 计算 stats
            ↓ POST /api/v1/stats
[阶段 6]  Dashboard 入库 + 展示
```

**追踪技术**：

- **用户报"上报数据错"** → 从 `last_upload_payload.json`（阶段 5 输出）开始 → 看是否有记录 → 没有则查 hook（阶段 4）→ 有但数值错则查 git note（阶段 5）→ note 错则查 working_logs（阶段 3）→ 以此类推
- **用户报"插件没反应"** → 看 DevTools Console（阶段 1）有没有日志 → 没有说明插件没激活 → 有但停在某步则确认是哪步
- **用户报"git commit 卡很久 / hook 太慢"** → 直接走 `references/performance-optimization.md`，按瓶颈阶段分类

### 原则 3：差异化分析

当**部分场景工作、部分不工作**时，问"差异是什么"：

- 同一个用户：commit A 正常，commit B 异常 → 比较两个 commit 的 reflog/diff/working_logs
- 不同用户：A 正常 B 异常 → 比较 OS、路径结构、workspace 配置
- 同一文件：第一次 commit 正常，第二次异常 → 检查跨 commit 的 INITIAL 文件传递
- **同一插件版本，C 盘客户快、D 盘客户慢** → 直奔 `performance-optimization.md` §2 慢盘环境识别

这是最高效的方法。一旦找到唯一变量，根因就接近了。

### 原则 4：用真实数据复现

用户给的 commit SHA、文件路径就是最好的测试用例：

```bash
# 直接拿用户的真实 SHA 跑命令验证
git -C <repo> notes --ref=ai show <user-reported-sha>
git -C <repo> reflog show HEAD | head -10
cat <repo>/.git/ai/working_logs/<sha>/INITIAL
```

不要造合成测试场景——它们经常掩盖真实问题。

### 原则 5：把环境问题和代码问题分开判断

参考 `references/env-vs-code-signals.md` 的判断表，关键区分：

- **环境**：特定 OS/特定路径结构/特定权限/网络受限 → 不同机器表现不同
- **代码**：相同输入永远产生错误输出 → 与环境无关

**陷阱**：很多看起来像代码 bug 的问题其实是环境（如 Windows 盘符大小写、路径分隔符、Defender 实时扫描），反之亦然。判断错会导致错误的处理方向。

### 原则 6：性能问题先看版本时间线

性能类症状（"卡 70s"、"hook 跑不完"）必须先确认插件版本，对照 `performance-optimization.md` §9 的版本时间线：客户在 0.2.9 之前的版本本身就有 70-110s 的已知耗时分布，引导升级即可，不要当作新 bug 排查。

---

## 标准流程（6 步）

> **默认假设**（不要重复问客户）：
> - **OS**：Windows（如 DevTools 日志或终端输出明确显示是 macOS/Linux 才改判）
> - **插件版本**：最新版（不要假定是某个已知 bug）
> - **git 仓库路径**：从当前 workspace 自动检测——`git -C <workspace> rev-parse --show-toplevel`，多 repo 时用 `findGitReposInDir` 思路递归扫描；不要让客户填路径
> - **machine_id / 用户身份**：直接从 `last_upload_payload.json` 的最近 `[userSync]` 行提取，不要让客户找
>
> **只在以下情况下问客户**：自动检测拿不到、或自动检测的值与症状矛盾。

### DevTools 日志快速指引（按需使用）

业务证据（`.git/ai/`）解决不了 / 怀疑插件代码层行为（激活、解析、checkpoint 调用、re-route、orphan）时，**必须看 DevTools Console**。这是插件代码 `console.log/warn/error` 直接打印的实时日志，业务证据文件无法替代。

**何时让客户打开 DevTools 复制日志**：

- DevTools Console 是已收集证据的下一步主要来源（如 `last_upload_payload.json` 没有任何记录、或 hook 没装上）
- 症状只在 IDE 内复现（如"AI 编辑没识别"、"checkpoint 没触发"）
- 想确认插件激活状态、看到 `[git-ai-kiro] Activating extension`

**让客户操作的标准话术**（直接复制发给客户）：

```
请按以下步骤导出插件日志（仅复制文字，不会改任何东西）：

1. 顶部菜单：Help（帮助） → Toggle Developer Tools（切换开发人员工具）
   ⌨️ 快捷键：Windows 是 Ctrl+Shift+I，macOS 是 Cmd+Option+I
2. 切到 Console 标签
3. 顶部 Filter 输入框输入：git-ai-kiro
4. 复现一次问题（按之前的步骤）
5. 复制 Console 中所有 [git-ai-kiro] 开头的行：
   - Ctrl/Cmd+A 全选 → Ctrl/Cmd+C 复制 → 粘贴到回复
   - 或在 Console 区域右键 → Save as... 保存成 .log 文件发我
```

**让客户**复现前**先打开** DevTools 才有完整日志（关闭 DevTools 时丢历史），所以话术中"先打开再复现"的顺序不能颠倒。

---

### Step 1 — 听完整症状

不要打断用户。让他说完，然后**用自己的话复述一遍**："你的意思是 X 操作后期望 Y 但实际 Z，对吗？"——歧义要在这里消除。

**最少必要信息**（自动检测优先，不能再砍）：
- 复现步骤（精确到 AI 操作 → commit → 期望/实际）
- 出问题的 commit SHA（如有）

**仅当自动检测失败时再问**：
- OS / 插件版本（默认 Windows + 最新版，不主动问）
- 是必现还是偶现
- 仓库路径（默认从 workspace 自动检测）

### Step 2 — 触发证据收集

**默认 skill 自己代跑**（autopilot 模式）：

1. 用 `git -C <workspace> rev-parse --show-toplevel` 自动确定 `REPO_ROOT`
2. 直接执行 `scripts/collect-diagnostics.sh`（macOS/Linux）或 `.ps1`（Windows）——脚本内部用 `git rev-parse` 自动拿仓库根，**不需要客户传任何参数**
3. 读取脚本输出文件分析

**仅当远程协助、skill 拿不到 shell 权限时**才让客户跑：
- macOS/Linux: `sh collect-diagnostics.sh > diagnostics.txt 2>&1`
- Windows: `.\collect-diagnostics.ps1 > diagnostics.txt`

诊断包内容：插件版本、hook 内容、`.git/ai/` 全部文件、reflog、git note、q-client.log、curl/sh 可用性。

性能类问题额外读取（同样 skill 自己拉）：
- `<REPO_ROOT>/.git/ai/logs/post-commit-YYYY-MM-DD.log`（含 `GITAI-TIMING:` 阶段计时）
- 让客户跑一次 `time git commit --allow-empty -m "diag"` 给总耗时

**何时主动让客户复制 DevTools Console 日志**（diagnostics 脚本拿不到这部分）：

- 诊断脚本输出无法解释症状（如 `last_upload_payload.json` 完全为空、hook 没装）
- 怀疑流水线阶段 0-3（execution log 解析、AI 操作识别、checkpoint 调用）——这些行为只在 IDE 进程内，不落到 `.git/ai/`
- 客户报"插件好像没生效"——必须看 DevTools 才能确认是否激活

引用上面"DevTools 日志快速指引"中的标准话术发给客户，不要让客户自己研究怎么开。

### Step 3 — 流水线定位（核心）

按 `references/investigation-playbook.md` 的"按症状索引到阶段"表，定位到流水线的哪一级：

- 输出（last_upload_payload.json）有问题 → 流水线的哪一步先出错？
- 用户给的"症状日志"对应哪个阶段的输出？
- 性能症状 → 切到 `references/performance-optimization.md` §1 症状索引

把范围缩小到 1-2 个阶段后再进入下一步。

### Step 4 — 定性：环境 vs 代码

对定位到的阶段，先**从已收集证据自查**（详见 `references/env-vs-code-signals.md`）：

1. 这个问题在不同环境（OS/路径/权限）下表现一致吗？（看 dashboard 上报记录）
2. 切换网络/换 workspace/换路径后是否依然？（看 reflog / payload 历史）
3. 能在我们的 dev 环境复现吗？

**仅当证据无法定性时**，问客户 1 个最关键的问题（不要一次问多个）：
- 性能类：仓库是不是放在非 C 盘 / 装了 Defender？（不要问"切换到 SSD 后是否消失"，先看证据再决定让不让客户测）

**走向不同分支**：
- → 环境问题：用户侧修复
- → 代码 bug：进入 Step 5
- → 已知性能瓶颈：参照 `performance-optimization.md` 给出对应优化方案或升级建议

### Step 5 — 代码深挖（仅当必要）

按 `references/code-lookup.md` 查找对应模块的源码。

**优先级**：

1. **客户机本地**：插件自带 `<extension-dir>/support-sources/` 目录，含核心 TS/Rust 源码副本（打包时同步）。让客户读这里的文件并提供，不需要客户访问 GitHub。
2. **GitHub 实时**：用 `web_fetch` 拉最新版（适合验证 bug 是否在新版已修）

**注意**：
- 客户机上 `out/` 目录是编译后的 JS（`tsc` 输出），不是 TS 源码
- 行号要对应到 `support-sources/kiro-plugin/src/<file>.ts` 而非 `out/<file>.js`

---

### Step 6 — 证据不足时：实时复现 + 中途暂停（兜底手段）

**触发时机**：当 Step 2-5 收集到的"事后证据"不足以定位根因时（例如关键中间文件已被覆盖、`working_logs` 已被下一次 commit 刷新、execution log 被追加混杂），不要再硬猜——**让用户重新操作一次，并在关键时刻暂停**，捕获中间状态。

**为什么需要暂停**：流水线很多关键文件是**瞬时存在或会被覆盖**的：

| 文件/状态 | 何时被覆盖/清理 |
|----------|---------------|
| `<repo>/.git/ai/.payload.tmp` / `.commit_msg.tmp` | hook 执行成功后立即删除 |
| `<repo>/.git/ai/working_logs/<base_sha>/` | 下次 commit 后 `<base_sha>` 切换，旧目录可能被压缩或忽略 |
| `<repo>/.git/ai/working_logs/<sha>/INITIAL` | 仅在 sha 仍是当前 HEAD 的 parent 时活跃 |
| Kiro execution log 文件 | 同一 session 后续 AI 操作会追加，混入新数据 |
| DevTools Console | 用户重启 IDE / 关闭 DevTools 即丢失 |
| `git reflog` 的 `HEAD@{1}` | 任何后续 commit / amend 都会推移 |
| `<repo>/.git/ai/post-commit.lock`（0.2.9+） | flock 释放后立即清空 |

**按流水线阶段决定暂停时机**：

| 怀疑阶段 | 让用户暂停的时机 | 暂停期间收集 |
|---------|----------------|-------------|
| **阶段 0-1**（execution log 解析、AI 操作未识别） | AI 编辑刚完成，**还没动 git** 时暂停 | DevTools Console 全量日志、execution log 文件原始内容、`sessions.json` |
| **阶段 2**（路径分组、orphan / re-route） | AI 编辑完成，**还没 commit** 时暂停 | DevTools Console（看 `Processing/Skipping/Re-routed/Orphan` 日志）、`workspace.workspaceFolders` 配置 |
| **阶段 3-4**（checkpoint 调用、working_logs 写入） | AI 编辑完成、checkpoint 已调（看到 `AI checkpoint succeeded`），**还没 commit** 时暂停 | `working_logs/<HEAD_sha>/INITIAL`、`working_logs/<HEAD_sha>/checkpoints.jsonl`、`blobs/` 内容 |
| **阶段 5a**（pre-commit hook） | 用户**正要 commit 但先手动跑** `sh .git/hooks/pre-commit`，看输出后再真正 commit | pre-commit 的 stderr / stdout、新增的 `checkpoints.jsonl` 行 |
| **阶段 5b**（post-commit、git note 计算） | commit 完成立刻暂停，**绝对不要再做下一次 commit/amend** | `git notes --ref=ai show <sha>`、`post_commit_debug.log` 当次 block、`working_logs/<parent>/` 完整状态 |
| **阶段 5c**（stats 上报） | hook 执行**前手动跑** `sh .git/hooks/post-commit` 抓 `.payload.tmp` | 暂时改 hook 添加 `cp .payload.tmp .payload.kept` 保留副本（让用户改完再恢复） |
| **性能瓶颈**（hook 卡某一阶段） | 让客户在 commit 后立刻 `cat .git/ai/logs/post-commit-*.log`，**确认 setsid 是否生效**（< 5s 返回则改造已生效） | `GITAI-TIMING:` 各阶段值、`acquired post-commit lock` 标记、是否 `skipped due to lock` |

**话术示例**（让用户配合暂停）：

> 注意：所有 `<repo>` 占位符在话术里**直接替换为已自动检测到的仓库绝对路径**再发给客户，不要让客户填路径。

```
为了精准定位，我需要捕获中间状态——这些文件会在下一个 commit 后消失。麻烦：

1. 现在【先不要 commit】
2. 在 Kiro 中复现一次 AI 编辑（操作 X）
3. 编辑完成后，DevTools Console 看到 "AI checkpoint succeeded" 后，立即：
   a. 把 DevTools Console 全量日志导出（右键 Save as...）
   b. 把这个目录打包发我：<repo>/.git/ai/working_logs/$(git -C <repo> rev-parse HEAD)/
   c. 不要做任何 git 操作（包括 add / commit / amend）
4. 收到我的回复后再继续 commit
```

```
现在的问题需要看到 commit 后的瞬时状态——请：

1. 复现一次 AI 编辑 + commit（按以前的步骤）
2. commit 完成后【立刻停下来】，不要再做下一次操作（不要再 commit、不要 amend、不要切分支）
3. 把以下打包发我：
   - <repo>/.git/ai/post_commit_debug.log（最后 200 行）
   - <repo>/.git/ai/last_upload_payload.json（最后 200 KB）
   - git -C <repo> notes --ref=ai show HEAD 的输出
   - <repo>/.git/ai/working_logs/$(git -C <repo> rev-parse HEAD^)/INITIAL
4. 收到我回复前不要再做任何 git 操作
```

**关键原则**：

- 让用户**只复现一次**，不要让他反复操作——每次操作都会刷新中间状态，调试更难
- 暂停指令必须**具体到操作**（"不要 commit"、"不要切分支"），不能只说"等一下"
- 收集完证据后明确告诉用户**可以继续**（"现在可以正常使用了"），避免用户卡住
- 如果客户表示"线上环境不好暂停"，问能否**找一个测试 repo 复现**——多数 bug 在干净环境也能复现

---

## 输出要求

最终回复给用户/开发者时，必须包含：

1. **症状概述**：1-2 句话描述用户报的现象
2. **证据链**：3-5 条关键日志/文件内容，足以独立支撑结论
3. **根因定位**：精确到流水线阶段 + 具体函数（如适用）
4. **分类**：环境 / 代码 / 已知性能瓶颈
5. **处理方案**：
   - 环境 → 用户侧具体步骤
   - 代码 → 给开发者的修复建议（可参考的修改点 + 测试用例）
   - 已知性能瓶颈 → 升级到 ≥ 0.2.9 + 配套环境调整（Defender 排除等）

---

## 参考资料（按需加载）

- `references/methodology.md` — 方法论详解，包含真实排查案例和反例
- `references/investigation-playbook.md` — 按症状索引到流水线阶段，每个阶段的关键证据
- `references/env-vs-code-signals.md` — 环境 vs 代码的判断信号
- `references/evidence-collection.md` — 各类证据文件解读（替代旧 log-analysis）
- `references/code-lookup.md` — GitHub 源码速查（按需拉取）
- `references/architecture.md` — 模块数据流（理解全貌）
- `references/performance-optimization.md` — 性能优化方法论与已落地优化清单（setsid / flock / 慢盘 / 反优化教训 / GITAI-TIMING）
- `scripts/collect-diagnostics.sh` / `.ps1` — 一键诊断脚本
- `scripts/analyze-payload.sh` — 上报记录趋势分析

---

## 反模式（不要做的事）

- ❌ 用户说"X 不工作"就立刻在脑子里假设"这肯定是 Y"——先读证据
- ❌ 凭借类似问题的记忆给方案——这次的现象可能完全不同
- ❌ 让客户提供整个 workspace 或源码——只要诊断包就够
- ❌ 一次问 10 个问题——按流水线阶段聚焦问 1-2 个
- ❌ 给"试试升级版本"作为唯一方案——没分析根因就给建议是浪费时间
- ❌ 把代码 bug 当成环境问题让用户自己解决——只会让问题二次出现
- ❌ 证据不足时硬猜——直接走 Step 6，让用户实时复现并暂停捕获中间状态
- ❌ 让用户在中间状态被覆盖前反复操作（如"再 commit 几次试试"）——会冲掉关键证据
- ❌ 把性能问题当数据 bug 排查（hook 慢 ≠ stats 错）——先看 `performance-optimization.md` §1 症状索引
- ❌ 在自检环境（C 盘 SSD）确认性能优化通过就上线——必须在客户慢盘环境（D 盘 + Defender）实测，否则可能反向优化（参见 `performance-optimization.md` §7.1）
- ❌ 看到客户任务管理器一堆 git-ai.exe 就建议加 `taskkill //F //IM git-ai.exe`——0.2.9+ 已删除该清理（多 hook 并发会误杀）
- ❌ 让客户回答能从环境/工具自动检测到的信息（OS、插件版本、仓库路径、machine_id）——客户每多答一个问题就多一次流失风险
- ❌ 让客户自己研究怎么打开 DevTools / 怎么复制 Console——直接给"DevTools 日志快速指引"中的标准话术（路径、快捷键、过滤、复制方式都已写好）
- ❌ 让客户在没打开 DevTools 的情况下复现问题——Console 历史日志关闭即丢，必须先开后复现
