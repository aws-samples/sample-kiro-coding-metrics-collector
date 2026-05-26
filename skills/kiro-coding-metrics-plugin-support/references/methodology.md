# 排查方法论详解

本文档把项目历次排查中发现的**有效模式**和**反面教训**沉淀下来。每个原则都配有真实案例（取自实际项目排查记录）。

---

## 原则 1：证据先行，禁止猜测

### 1.1 真实案例：amend 修复失败

**情境**：用户报"amend commit 数据全计入人工"。

**反例（错误流程）**：
> "听起来是 amend 的处理逻辑问题，可能是 hook 的 `--amend-from` 没传对。让我改一下逻辑试试。"

→ 改了多次都没修好，因为根本没找到真正原因。

**正确流程**：
1. 先读证据：用户给了 commit SHA `16d8df9`
2. 检查 git note：`prompts: {}` 为空 → 确认 git-ai 没正确处理
3. 检查 reflog：找到 `HEAD@{1}` 是 `60064e1`
4. 检查 `ORIG_HEAD`：是 `1003976e`（**完全不相关的 commit**）
5. 看 hook 代码：用 `ORIG_HEAD` 取 OLD_SHA → 拿到错误的 SHA
6. **真正的根因**：`git commit --amend` 不更新 `ORIG_HEAD`，只更新 `HEAD@{1}`

**关键教训**：先收集证据，让证据指向根因。如果跳过证据直接改代码，会陷入"改两次同样的错"循环。

### 1.2 引用具体证据的写法

```
❌ "git-ai 在处理 amend 时有问题"
✅ "在 .git/ai/last_upload_payload.json 中：
    {"commit_sha":"16d8df9...","ai_additions":0,"human_additions":4}
   git notes --ref=ai show 16d8df9 显示：
    {"prompts": {}}
   git reflog show HEAD 显示：
    16d8df9 HEAD@{0}: commit (amend): v
    60064e1 HEAD@{1}: commit: v
   而 hook 中读取的 OLD_SHA = ORIG_HEAD = 1003976e（与 reflog 不一致）"
```

### 1.3 当用户的猜测错误时

用户经常会说："我觉得是 X 引起的"。**不要照搬当作分析方向**，但要记下来作为线索之一。

例：用户说"我觉得是网络问题导致 macOS 上传失败"。

实际验证：
- 让用户跑 `curl -v https://<dashboard>` → 网络连通
- 让用户跑 `sh .git/hooks/post-commit` → 报 `cannot execute binary file`
- → 真因：插件 bin/ 目录有 Windows 的 curl.exe，hook 在 macOS 上误把它当 curl 执行

### 1.4 证据不足时的处理

不要拍脑袋，而是**列出所需证据**让用户提供：

> "目前的诊断信息不足以判断根因。请提供：
> 1. 出问题 commit 的 SHA（如 abc123）
> 2. `.git/ai/post_commit_debug.log` 中该 commit 对应的块
> 3. `git -C <repo> notes --ref=ai show abc123` 的输出"

---

## 原则 2：流水线端到端追踪

### 2.1 整条流水线的"输入-输出"对应关系

| 阶段 | 输入 | 输出（可观测） | 失败信号 |
|------|------|--------------|---------|
| 0. AI 编辑 | 用户操作 | execution log 文件大小变化 | 文件大小不变 |
| 1. 解析 log | execution log JSON | `[git-ai-kiro] Parsed ...: actions=N` | actions=0 / parse 失败 |
| 2. 路径分组 | WriteAction[] | `Sending AI checkpoint for repo X: edited_filepaths=[...]` | "Orphan file" / "Skipping file outside workspace" |
| 3. checkpoint 调用 | dirty_files JSON | `git-ai exited with code 0` | exit code != 0 / "Failed to find any git repositories" |
| 4. working_logs 写入 | checkpoint result | `working_logs/<sha>/checkpoints.jsonl` 行数增加 | 文件不存在 / 行数不变 |
| 5. post-commit | git commit | `last_upload_payload.json` 追加 [stats] 行 | 没有新行 |
| 6. dashboard | HTTP POST | dashboard 列表更新 | 网络错误 / 4xx/5xx |

### 2.2 真实案例：跨 commit AI 归属丢失

**症状**：AI 一次修改 3 个文件，分两次 commit。第二次 commit 的 `ai_additions` 远小于实际 AI 行数。

**端到端追踪**：

1. **阶段 6（dashboard）**：上报数据 `ai_additions=92, human_additions=14`，期望 `ai_additions=106, human_additions=0`
2. **阶段 5（post-commit）**：看 `git notes --ref=ai show <commit2>`，发现 `accepted_lines: 92`，确认归属丢了 14 行
3. **阶段 4（working_logs）**：检查 `working_logs/<commit1>/INITIAL`，发现 `start_line: 123, end_line: 161`（**连续范围**记录了 39 行 AI）
4. **阶段 5 内部**：`post_commit_debug.log` 显示 Human checkpoint 的 `line_attributions` 只有 5 个分段（不是连续 1 个范围）
5. **关键差异**：INITIAL 是 39 行连续范围，但 Human checkpoint 把它拆成了 5 段——拆段处的空行变成了 human

**根因定位**：`attributions_to_line_attributions` 把空行排除了（因为空行无字符级 attribution），导致连续 AI 范围被拆段。空行间隙被归为 human。

**关键教训**：从输出反向追踪到第一个数据丢失点。不要跳跃式假设。

### 2.3 追踪技巧

**技巧 A：用唯一标识符贯穿**

每个 AI 编辑都有 `prompt_id`（如 `18167e8315322a86`）。从 `working_logs/<sha>/checkpoints.jsonl` 中找到 prompt_id，到 `git note` 中查它的 `accepted_lines`，再到 `git diff --json` 中查它的 `annotations`——一条线追踪。

**技巧 B：时间戳对齐**

- `last_upload_payload.json` 中 `[stats] [TIMESTAMP]`
- DevTools Console 中 `[git-ai-kiro] ...` 的时间戳
- `git log --format=%aI <sha>` 的时间戳
- `post_commit_debug.log` 中 `--- 1778672626 ---` 的 unix timestamp

时间戳对不上 → 流水线某环节延迟或乱序，需要怀疑并发问题。

**技巧 C：当流水线某阶段无输出**

直接手动跑该阶段：
```bash
# 阶段 3：手动调用 git-ai checkpoint
echo '<payload-json>' | git-ai checkpoint agent-v1 --hook-input stdin

# 阶段 5：手动跑 post-commit hook
sh .git/hooks/post-commit

# 阶段 6：手动 curl
curl -v -X POST <dashboard-url> -d @<payload-file>
```

---

## 原则 3：差异化分析

### 3.1 真实案例：Windows 上 sh 探测不一致

**情境**：A 用户 Windows 上 sh hook 工作正常，B 用户 Windows 上日志显示 "sh.exe not available"。

**差异化提问**：
- A 和 B 都装了 Git for Windows 吗？→ 都装了
- 都装在默认路径吗？→ B 装在 `D:\Tools\Git`
- A 和 B 启动 Kiro 的方式一样吗？→ A 从开始菜单，B 从 .lnk 快捷方式

**进一步差异化**：在 B 机器上手动跑 `where sh.exe`：
- cmd 中：找到 `D:\Tools\Git\bin\sh.exe`
- Kiro 进程的 spawnSync：找不到

**根因**：Kiro 进程从 .lnk 启动时不继承用户完整 PATH，但能继承 git。

**修复策略**：通过 `git --exec-path` 推断 Git 安装目录下的 sh.exe。

**关键教训**：找到唯一变量（启动方式），就接近了根因。

### 3.2 差异化的提问框架

```
"工作的环境" vs "不工作的环境"，问：
1. OS / OS 版本相同吗？
2. 插件版本相同吗？
3. 工作路径结构相同吗？（深度、是否有空格/中文）
4. 是同一个 git repo 吗？（amend 历史、submodule、特殊钩子）
5. 是同一个 workspace 配置吗？（单根/多根 .code-workspace）
6. 用户权限相同吗？（管理员/普通用户）
7. 网络环境相同吗？（公司内网 vs 家庭网络）

"工作的场景" vs "不工作的场景"，问：
1. 文件路径有什么差异？（深度、字符、是否包含 ..）
2. 操作类型有差异？（仅 AI / AI+人工 / amend / multi-file）
3. 时间间隔有差异？（连续 commit / 隔了很久）
4. 文件大小/行数有差异？
```

---

## 原则 4：用真实数据复现

### 4.1 真实案例：commit_msg 中文导致上报失败

**用户报告**：Windows 上 commit message 包含中文时，上报失败。

**做法**：
1. **不要造合成场景**：不要用"假设 commit message 是 中文"
2. **要用用户给的真实 SHA**：让用户提供具体失败的 commit SHA
3. **直接复现**：`git log --pretty=%s <sha>` → 看到原始字节
4. **手动跑 hook 逐步**：把 PAYLOAD 拼接拆成多步，看哪一步字节流被破坏

**发现**：
- `git log --pretty=%s <sha>` 直接输出 → 字节正常
- `COMMIT_MSG=$(git log ...)` → shell 变量赋值后字节被错误转码（GBK→UTF-8）
- `printf '...%s...' "$COMMIT_MSG"` → 输出已经是错误编码

**修复策略**：commit_msg 全程在文件中，不进入 shell 变量。

**关键教训**：合成场景"AAA中文BBB"和真实场景"修复用户登录bug"的字节序列不一样，编码 bug 用真实数据才暴露得出来。

### 4.2 复现失败时

如果支持人员的环境复现不出来，**不要假设是用户机器问题**。可能性排序：

1. 用户提供的复现步骤不完整（再问一遍）
2. 环境差异导致（看原则 3）
3. 时序/并发问题（让用户多复现几次看是否每次都失败）
4. 数据差异（用户的 .git 历史、execution log 内容）

让用户用 `collect-diagnostics.sh` 收集证据包发过来，从证据中找差异。

---

## 原则 5：把环境问题和代码问题分开判断

### 5.1 真实案例：macOS 上 post-commit 不能上报

**初看像代码问题**：所有 macOS 用户都报这个，看起来代码逻辑错。

**深挖发现是环境**：
- 插件 bin/ 目录下打包了 `curl.exe`（Windows binary）
- macOS 上 hook 用了 `if [ -f "$CURL_CMD" ]; then` 判断
- macOS 上文件存在 → 选了 `curl.exe`
- 执行 Windows binary 失败被 `|| true` 吞掉

**为什么算环境**：因为 macOS 文件系统上确实有这个文件（环境特征），而非代码逻辑错。代码的判断逻辑（"如果文件存在就用它"）本身没问题，但**对环境的假设**（"curl.exe 这个文件名只可能是 Windows curl"）错了。

**修复策略**：用 `uname -s` 检测平台，只在 Windows 用插件 curl.exe。

### 5.2 真实案例：commit_msg 中文导致上报失败

**初看像环境**：只有 Windows 中文 commit message 出问题。

**深挖发现是代码**：
- shell 变量赋值时字节被转码 → 这是 shell 在所有平台都会做
- Windows 上恰好默认编码是 GBK，与 git output 的字节流不一致 → 暴露问题
- 修复方法在代码中（不让 commit_msg 进入 shell 变量），不在用户配置中

**为什么算代码**：因为不论用户什么环境，只要 git 输出字节流不是当前 shell 编码，问题都会出现。修复在代码层面。

### 5.3 判断信号汇总（详见 env-vs-code-signals.md）

**指向环境的信号**：
- 部分机器复现，部分不复现
- 与特定 OS / 路径深度 / 权限相关
- 用户配置改了之后立即变好
- 出错时间点与外部事件（网络抖动、系统更新）相关

**指向代码的信号**：
- 100% 必现
- 同一函数对相同输入永远产生错误输出
- 不同 OS 都能复现（即使现象不同，根因相同）
- 临时 workaround 是改用户配置，但根本修复需要改代码

---

## 原则 6：必要时让用户实时复现 + 中途暂停（兜底手段）

### 6.1 为什么需要这个原则

前 5 个原则都假设"事后能从落盘文件读到证据"。但流水线很多关键状态是**瞬时**的或会被**下一次操作覆盖**：

- `working_logs/<base_sha>/` 在下次 commit 后，`base_sha` 会切换，旧目录的 INITIAL 不再是当前活跃状态
- `.payload.tmp` / `.commit_msg.tmp` 在 hook 跑成功后立即删除
- DevTools Console 用户重启 IDE 就丢
- `git reflog` 的 `HEAD@{1}` 任何后续 commit/amend 都会推移
- Kiro execution log 同 session 后续操作会追加新数据混入

当**事后证据已丢**或**只有间接证据**时，再硬猜是浪费时间。**让用户重新操作一次，并在关键时刻暂停**——这是定位很多疑难问题的唯一办法。

### 6.2 真实案例：跨 commit AI 归属丢失（如何用暂停定位）

回看原则 2.2 的案例。最初拿到的证据：
- 阶段 5/6 的 `last_upload_payload.json` 显示 `ai_additions=92`（应是 106）
- 阶段 5b 的 `git note` 显示 `accepted_lines=92`

但**为什么是 92 而不是 106**？光看事后证据看不出来——14 行的归属是在哪一步丢的？需要看：
- 阶段 4：`working_logs/<commit1>/INITIAL` 中的 line ranges
- 阶段 5a：Human checkpoint 的 `line_attributions`

如果用户已经做了 commit 2 之后的下一个 commit，`working_logs/<commit1>/` 已被清理，无从下手。

**正确做法**：让用户**重新复现一次**，并要求"commit 2 完成后立刻停下，不要做任何后续操作"，这样：
- `working_logs/<commit1>/INITIAL` 还在
- `working_logs/<commit1>/checkpoints.jsonl` 完整记录了 Human checkpoint 的 entries
- 通过对比 `INITIAL.start_line/end_line`（连续 21-27）和 `checkpoint.line_attributions`（被拆成 21-22, 24-25, 27-27）→ 立刻看出空行被排除的根因。

如果让用户继续操作，这些证据每次 commit 都会被刷新，定位需要的迭代轮数会翻倍。

### 6.3 暂停时机——按怀疑的流水线阶段选择

| 怀疑阶段 | 暂停时机 | 暂停期间禁止的操作 | 收集的证据 |
|---------|---------|------------------|-----------|
| 阶段 0-1 | AI 编辑刚完成 | 不要 git add/commit、不要切分支、不要做新的 AI 操作 | DevTools Console 全量、execution log 原始内容、`sessions.json` |
| 阶段 2 | AI 编辑完成 | 不要 commit | DevTools Console（`Processing/Skipping/Re-routed/Orphan`）、`workspace.workspaceFolders` |
| 阶段 3-4 | `AI checkpoint succeeded` 后 | 不要 commit | `working_logs/<HEAD_sha>/INITIAL`、`checkpoints.jsonl`、`blobs/` |
| 阶段 5a | 即将 commit 时手动跑 hook | 真正 commit 之前先看 hook 输出 | pre-commit stderr、新增 `checkpoints.jsonl` 行 |
| 阶段 5b | commit 完成 | **绝对不要再 commit/amend/切分支** | `git note`、`post_commit_debug.log` 当次 block、`working_logs/<parent>/` 完整 |
| 阶段 5c | hook 之前手动跑 / 用临时 cp 保留 `.payload.tmp` | 不要让 hook 真正成功（先抓副本） | `.payload.tmp` 字节、`.commit_msg.tmp` |

### 6.4 话术模板

**暂停 + 收集（commit 前）**：
> 为了精准定位，需要捕获中间状态——这些文件在下次 commit 后会被刷新。麻烦：
> 1. **先不要 commit**
> 2. 在 Kiro 中复现一次 AI 编辑（操作 X）
> 3. DevTools Console 看到 `AI checkpoint succeeded` 后，立即：
>    a. 导出 Console 全量日志（右键 Save as...）
>    b. 打包发我：`<repo>/.git/ai/working_logs/$(git -C <repo> rev-parse HEAD)/`
>    c. 不要做任何 git 操作
> 4. 收到我的回复后再继续 commit

**暂停 + 收集（commit 后）**：
> 现在的问题需要看到 commit 后的瞬时状态——请：
> 1. 复现一次 AI 编辑 + commit（按以前步骤）
> 2. commit 完成后**立刻停下来**，不要再做下一次操作（不 commit、不 amend、不切分支）
> 3. 打包以下文件发我：
>    - `<repo>/.git/ai/post_commit_debug.log`（最后 200 行）
>    - `<repo>/.git/ai/last_upload_payload.json`（最后 200 KB）
>    - `git -C <repo> notes --ref=ai show HEAD` 的输出
>    - `<repo>/.git/ai/working_logs/$(git -C <repo> rev-parse HEAD^)/INITIAL`
> 4. 收到我回复前不要再做任何 git 操作

**收集后解除暂停**：
> 已收到证据，可以正常继续使用。

### 6.5 暂停的注意事项

**只让用户复现一次**：每复现一次都重置中间状态。如果第一次的证据不全，先想清楚还需要什么再让用户来第二次，避免反复打扰。

**指令必须具体到操作**：不要说"等一下"，要说"不要 commit、不要 amend、不要切分支"。用户对术语理解不一，越具体越好。

**明确解除暂停**：收到证据后告诉用户"现在可以继续"，避免用户卡住。

**线上环境不好暂停时**：让用户在测试 repo 里复现——多数 bug 在干净环境也复现得出来；只有少数与历史相关的 bug 必须在原 repo（这种情况让用户做完一个备份）。

**不要让用户跑修改代码的命令**：暂停期间收集证据用的命令应**只读**（cat / git note show / ls），不要让用户跑 `git reset` / `rm` / 修改 hook。

### 6.6 何时不应该走 Step 6

- 用户已提供完整事后证据且足以定位 → 不要为了"更全面"再让用户复现，浪费时间
- 问题与时序无关、与文件覆盖无关（如纯环境问题：网络、curl 不可用） → 直接看配置即可
- 用户表示生产环境严格不能暂停且无测试环境 → 转为"事后证据 + 代码静态分析"路径，给开发者复现脚本
每改一次代码就重新打包给客户测，循环 3+ 次还没修好。
→ 停下来收集证据，找真正根因。

### A2. "类比式诊断"
"这看起来像之前 X 用户的问题，应该是同一个原因。"
→ 即使症状相似，根因也可能不同。证据先行。

### A3. "全量索取"
"麻烦把整个 workspace 给我看看。"
→ 用户没必要给敏感数据。`collect-diagnostics.sh` 收集的就够。

### A4. "模糊建议"
"试试重启 / 升级 / 重装。"
→ 没有根因分析的建议是浪费用户时间。

### A5. "代码当环境处理"
代码 bug 让用户改配置 workaround，没移交开发者。
→ 短期能用，长期同问题反复出现。判断错分类的代价很高。

### A6. "环境当代码处理"
环境问题改代码"防御"，引入复杂度。
→ 用户应该改自己的配置/路径，代码不需要处理所有环境的 edge case。

### A7. "证据不足时硬猜"
关键中间状态（working_logs、.payload.tmp、INITIAL）已被覆盖，但仍试图从残缺证据反推。
→ 直接走原则 6，让用户实时复现并暂停。

### A8. "让用户反复操作"
"再 commit 几次试试"、"再复现 5 遍看看"。
→ 每次操作都刷新中间状态。先想清楚需要什么证据，让用户**只复现一次**。

### A9. "暂停指令模糊"
"等一下不要操作"——用户不知道"操作"的范围。
→ 具体到动作："不要 commit、不要 amend、不要切分支、不要做新的 AI 编辑"。

---

## 总结：一句话方法论

> 用证据收集替代假设，用流水线追踪定位阶段，用差异分析锁定变量，用真实数据复现，把根因明确分类到环境或代码后再给方案；当事后证据已丢时，让用户实时复现并在中途暂停捕获中间状态。
