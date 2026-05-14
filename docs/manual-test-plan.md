# git-ai for Kiro 手动测试方案

## 测试环境准备

- Kiro IDE 安装 `git-ai-kiro` 插件（VSIX）
- 插件 API 地址已硬编码，无需额外配置
- 准备一个 git 仓库（如 `kiro-coverage-test`），包含几个已 commit 的文件
- 开发者工具控制台打开（`Help > Toggle Developer Tools`），过滤 `[git-ai-kiro]`

**子目录场景：**
- 可用 `kiro-coverage-test/sub1` 作为 workspace 测试子目录打开的情况

**父目录场景：**
- 可用 `kiro-coverage-test` 的父目录（如 `/Users/xxx/code`）作为 workspace 测试

## 测试用例

### 一、基础场景

| # | 用例 | 操作步骤 | 预期结果 |
|---|------|---------|---------|
| 1 | AI 纯新增 | 让 AI 在已有文件中新增 3 行代码，commit | ai_additions=3, human_additions=0, mixed_additions=0 |
| 2 | 人工纯新增 | 手动在文件中新增 2 行代码，保存，commit | ai_additions=0, human_additions=2, mixed_additions=0 |
| 3 | AI 纯删除行 | 已有文件 10 行 → 让 AI 删除其中 3 行 → commit | git_diff_deleted_lines=3, ai_deletions=3, human_deletions=0 |
| 4 | 人工纯删除行 | 已有文件 10 行 → 手动删除其中 2 行 → commit | git_diff_deleted_lines=2, ai_deletions=0, human_deletions=2 |
| 5 | AI 纯修改行（替换） | 已有文件 → 让 AI 替换其中 3 行内容 → commit | ai_additions=3, ai_deletions=3, human_additions=0, human_deletions=0 |
| 6 | 人工纯修改行（替换） | 已有文件 → 手动替换其中 2 行内容 → commit | ai_additions=0, ai_deletions=0, human_additions=2, human_deletions=2 |
| 7 | 新文件（AI 创建） | AI 创建一个全新文件（10 行），commit | ai_additions=10 |
| 8 | 新文件（人工创建） | 手动创建一个全新文件（5 行），commit | human_additions=5 |

### 二、混合编辑场景

| # | 用例 | 操作步骤 | 预期结果 |
|---|------|---------|---------|
| 9 | AI 新增后人工修改 | AI 新增 3 行 → 手动修改其中 1 行 → commit | ai_additions=2, mixed_additions=1 |
| 10 | 人工新增后 AI 修改 | 手动新增 3 行 → AI 修改其中 1 行 → commit | ai_additions=1, human_additions=2。注意：此场景不产生 mixed_additions（mixed 只在"AI 先写→人工后改"时产生） |
| 11 | AI 和人工各编辑不同文件 | AI 编辑 A.java（+3 行），手动编辑 B.java（+2 行），一起 commit | ai_additions=3, human_additions=2 |
| 12 | AI 创建文件后人工添加行 | AI 创建全新文件（10 行），人工添加 3 行，commit | ai_additions=10, human_additions=3 |
| 13 | AI 创建文件后人工修改行 | AI 创建全新文件（10 行），人工修改其中 3 行，commit | ai_additions=7, human_additions=3, mixed_additions=3 |

### 三、多次编辑场景

| # | 用例 | 操作步骤 | 预期结果 |
|---|------|---------|---------|
| 14 | AI 多次编辑同一文件 | AI 新增 2 行 → AI 再新增 3 行 → commit | ai_additions=5 |
| 15 | AI 新增后 AI 删除部分 | AI 新增 5 行 → AI 删除其中 2 行 → commit | ai_additions=3 |
| 16 | 人工多次保存 | 手动编辑，保存 3 次（每次改不同行），commit | human_additions = 最终 diff 的新增行数 |

### 四、文件重命名/移动场景

| # | 用例 | 操作步骤 | 预期结果 |
|---|------|---------|---------|
| 17 | AI 创建文件后人工移动 | AI 创建 `Foo.java`（6 行）→ 手动移动到子目录 → commit | ai_additions=6, human_additions=0 |
| 18 | AI 创建文件后人工改名 | AI 创建 `PrintFoo.java`（6 行）→ 手动重命名为 `PrintBar.java` → commit | ai_additions=6。注意：IDE 自动更新类名不经过 Kiro 执行日志，归属不确定 |
| 19 | 已有文件 AI 新增后人工改名 | 已有 `A.java`（10 行）→ AI 追加 3 行 → 手动重命名为 `B.java` → commit | ai_additions=3 注意：IDE  IDE 自动修改的类名行可能计入 human_additions |
| 20 | 已有文件 AI 新增后人工移动 | 已有 `A.java`（10 行）→ AI 追加 2 行 → 手动移动到子目录 → commit | ai_additions=2, human_additions=0 |
| 21 | AI 执行改名操作 | 让 AI 执行"将 A.java 改名为 B.java" | AI 通过 `mv` 命令改名，类名修改不产生 WriteAction。只有文件内容的写入操作才被追踪 |
| 22 | AI 改名后再编辑 | AI 将 A.java 改名为 B.java，再让 AI 新增 2 行 → commit | ai_additions=2。注意：改名时 IDE 自动修改的类名行可能计入 human_additions |

### 五、AI/人工删除行数精确统计场景

| # | 用例 | 操作步骤 | 预期结果 |
|---|------|---------|---------|
| 23 | AI 和人工各删除不同行 | 已有文件 10 行 → AI 删除 2 行 → 手动删除 1 行 → commit | ai_deletions=2, human_deletions=1 |
| 24 | AI 删除整个文件 | 已有文件 5 行 → 让 AI 删除该文件 → commit | ai_deletions=5, human_deletions=0 |
| 25 | 人工删除整个文件 | 已有文件 5 行 → 手动 `git rm` 该文件 → commit | ai_deletions=0, human_deletions=5 |
| 26 | 混合删除+新增 | AI 新增 3 行 + 删除 2 行，人工新增 1 行 + 删除 1 行 → commit | ai_deletions=2, human_deletions=1 |
| 27 | AI删除+新增 | AI 删除 3 行 + 新增 2 行 → commit | ai_deletions=3, ai_additions=2 |
| 28 | 删除行数守恒 | 任意删除操作后 commit | ai_deletions + human_deletions = git_diff_deleted_lines |
| 29 | 大文件混合删除精确性 | AI 在大文件中删除 10 行后人工删除 4 行 → commit | ai_deletions=10, human_deletions=4 |

### 六、Git 操作过滤场景

| # | 用例 | 操作步骤 | 预期结果 |
|---|------|---------|---------|
| 30 | git pull 不上报 | 在另一台机器 push 代码，本地 git pull | 不上报 |
| 31 | git merge 不上报 | 创建分支 B，在 B 上 commit，切回 main，git merge B | 不上报 |
| 32 | 解冲突后 commit 上报 | merge 产生冲突 → 手动解决 → git commit | 上报，冲突解决的行计入 human_additions |
| 33 |  commit amend 上报 | 在分支上 commit amend | 上报，与正常commit结果一致 |

### 七、工程化目录过滤场景

| # | 用例 | 操作步骤 | 预期结果 |
|---|------|---------|---------|
| 34 | node_modules/out/dist 不统计 | commit 包含 node_modules/、out/ 或 dist/ 下文件的变更 | 该文件的行数不计入任何指标 |
| 35 | lock 文件不统计 | commit 包含 package-lock.json 的变更 | 该文件的行数不计入 |
| 36 | 二进制文件不统计 | commit 包含 *.class、*.jar、*.exe 等文件 | 不计入 |

### 八、父、子目录打开场景

| # | 用例 | 操作步骤 | 预期结果 |
|---|------|---------|---------|
| 37 | 子目录打开 AI 编辑 | 用 Kiro 打开 `repo/sub1/`，AI 编辑 `sub1/Foo.java` | checkpoint 正确写入 git root 的 working_logs，路径为 `sub1/Foo.java` |
| 38 | 子目录打开 AI 删除文件 | 用 Kiro 打开 `repo/sub1/`，AI 删除 `sub1/Foo.java` | ai_deletions=对应行数 |
| 39 | 子目录打开 commit | 在 git root 目录执行 `git commit` | post-commit hook 正确触发，stats 上报正确 |
| 40 | 子目录打开无跨污染 | 只编辑 `sub1/` 下的文件 | working_logs 中不出现其他目录的文件 |
| 41 | 父目录 workspace AI 编辑 | 用 Kiro 打开 git 项目的父目录，AI 编辑子 repo 中的文件 | checkpoint 正确写入子 repo 的 `.git/ai/working_logs/` |
| 42 | 父目录 workspace AI 删除 | 用 Kiro 打开父目录，AI 删除子 repo 中的文件 | ai_deletions=对应行数 |
| 43 | 父目录 workspace commit | 用 Kiro 打开父目录，在子 repo 内 commit | post-commit hook 正确触发，stats 上报正确 |
| 44 | 父目录 workspace AI 修改 | 用 Kiro 打开父目录，AI 修改子 repo 中的已有文件 | checkpoint 路由到正确 git repo，ai_additions 正确 |

### 九、post-commit hook 场景

| # | 用例 | 操作步骤 | 预期结果 |
|---|------|---------|---------|
| 45 | hook 自动安装 | 安装插件后打开 git 仓库 | `.git/hooks/post-commit` 自动创建，包含 `git-ai-kiro` marker |
| 46 | hook 更新 | 重启插件 | hook 内容自动更新（旧 section 被替换） |
| 47 | 命令行 commit 上报 | 在终端执行 `git commit`（不在 Kiro IDE 内） | post-commit hook 触发，stats 上报到 dashboard |
| 48 | hook payload 调试 | commit 后查看 `.git/ai/last_upload_payload.json` | 文件存在且包含 `[stats]` 和 `[userSync]` 记录 |
| 49 | hook 上报含删除字段 | commit 后检查上报数据 | payload 中包含 ai_deletions 和 human_deletions 字段 |

### 十、上报服务场景

| # | 用例 | 操作步骤 | 预期结果 |
|---|------|---------|---------|
| 50 | 用户 email 获取 | 安装插件后查看日志 | 日志显示通过 kiro-cli / getUsageLimits API / git config 之一获取到 email |
| 51 | userSync 启动上报 | 插件启动 | Kiro Logs 中显示 `userSync payload: {user_name, user_ip, hostname}` |
| 52 | userSync 定时上报 | 插件运行 4 小时后 | 自动再次上报 userSync（每 4 小时定时） |
| 53 | userSync hostname 去重 | 查看 dashboard plugins 表 | 按 hostname 去重，同一主机只有一条记录 |
| 54 | Dashboard 用户 API | GET /api/users | 返回 activeSessions、activePlugins、pluginCoverage、totalPluginRate |
| 55 | S3 credit 同步 | 等待同步周期 | /api/users 中 totalCredits 显示从 S3 CSV 同步的数据 |
| 56 | CloudTrail session 同步 | dashboard 启动后 | sessions 表有数据，/api/users 中 activeSessions > 0 |
| 57 | 编码指标展示 | commit 后查看 Dashboard 服务数据 | AI 新增行、人工新增行、AI 删除行、人工删除行等指标显示正确 |

### 十一、边界场景
7
| # | 用例 | 操作步骤 | 预期结果 |
|---|------|---------|---------|
| 58 | 空 commit | `git commit --allow-empty -m "empty"` | 不上报或上报全 0 |
| 59 | 大文件编辑 | AI 在 200+ 行的文件中修改 10 行，commit | 只有修改的 10 行计入 |
| 60 | 插件重启后 | 重启 Kiro → AI 编辑 → commit | 正常工作（SessionLogWatcher 重新发现日志目录） |
| 61 | Windows hook TLS | Windows 上 commit 触发 hook 上报 | PowerShell 脚本强制 TLS 1.2，不报 SSL 错误 |
| 62 | 调试日志自动清理 | 持续使用 15 天以上 | `.git/ai/last_upload_payload.json` 中超过 15 天的记录自动清理 |

## 验证方法

每个用例 commit 后检查：

1. **控制台日志**：搜索 `[git-ai-kiro]`，确认 checkpoint 类型（ai_agent / human）和行数
2. **Dashboard 上报数据**：检查 ingest 服务日志中的 payload
3. **Checkpoint 文件**：检查 `.git/ai/working_logs/<base_commit>/checkpoints.jsonl`
4. **Git Note**：`git notes --ref=ai show <commit_sha>` 查看归属数据
5. **Stats 验证**：`git-ai stats <commit_sha> --json` 直接查询
6. **Diff 验证**：`git-ai diff <commit_sha> --json` 查看 hunks 中的 deletion 条目
7. **调试文件**：查看 `.git/ai/last_upload_payload.json` 中的上报记录

## 通过标准

- 所有 62 个用例的实际结果与预期结果一致
- 无控制台错误（ERR 级别）
- 上报的 ai_additions 已去除 mixed_additions（ai_additions = ai_accepted）
- ai_additions、ai_accepted、human_additions 均不超过 git_diff_added_lines
- ai_deletions + human_deletions = git_diff_deleted_lines（删除行数守恒）
- merge / rebase / pull 操作不产生上报
- Windows、macOS、Linux等系统上行为一致（路径、换行符已处理）
- 文件重命名/移动后，AI 编辑的行数正确归属
- post-commit hook 上报的 payload 中包含 ai_deletions 和 human_deletions 字段
- `.git/ai/last_upload_payload.json` 在每次 commit / userSync 后追加记录，15 天前的记录自动清理
- 父目录 workspace 场景下 checkpoint 写入正确的 git repo
- userSync 上报包含 hostname，plugins 表按 hostname 去重
- kiro_net_deletions 在 AI 有净删除时正确写入并被 hook 读取
