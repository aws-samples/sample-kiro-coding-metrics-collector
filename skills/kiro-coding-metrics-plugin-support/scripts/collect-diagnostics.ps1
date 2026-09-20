# git-ai-kiro 插件诊断信息收集脚本（Windows PowerShell）
# 用法: cd <git-repo>; .\collect-diagnostics.ps1 > diagnostics.txt
# ⚠️ 该脚本仅读取，不会修改任何文件

$ErrorActionPreference = 'SilentlyContinue'

$repoRoot = (git rev-parse --show-toplevel 2>$null) -join ""
if (-not $repoRoot) { $repoRoot = (Get-Location).Path }

Write-Output "==========================================="
Write-Output "git-ai-kiro 诊断信息收集"
Write-Output "==========================================="
Write-Output "时间: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
Write-Output "REPO_ROOT: $repoRoot"
Write-Output "OS: $([System.Environment]::OSVersion.VersionString) $([System.Environment]::Is64BitOperatingSystem)"
Write-Output "PowerShell: $($PSVersionTable.PSVersion)"
Write-Output ""

Write-Output "=== 1. Git 信息 ==="
git --version
git -C $repoRoot log --oneline -5
Write-Output ""
Write-Output "--- reflog (最近 10 条) ---"
git -C $repoRoot reflog -10
Write-Output ""

Write-Output "=== 2. 插件安装目录 ==="
$kiroExtDir = "$env:USERPROFILE\.kiro\extensions"
if (Test-Path $kiroExtDir) {
    Get-ChildItem $kiroExtDir | Where-Object { $_.Name -like "*git-ai*" } | Format-Table Name, LastWriteTime
    $gitAiDir = (Get-ChildItem $kiroExtDir | Where-Object { $_.Name -like "git-ai*" } | Select-Object -Last 1).FullName
    if ($gitAiDir) {
        Write-Output "--- 插件 package.json (前 5 行) ---"
        Get-Content "$gitAiDir\package.json" -TotalCount 5 -ErrorAction SilentlyContinue
        Write-Output ""
        Write-Output "--- bin 目录 ---"
        Get-ChildItem "$gitAiDir\bin" -ErrorAction SilentlyContinue | Format-Table Name, Length, LastWriteTime
    }
} else {
    Write-Output "(未找到 $kiroExtDir)"
}
Write-Output ""

Write-Output "=== 3. Hook 生效位置 (core.hooksPath) ==="
# 企业环境常把 core.hooksPath 指向安全工具目录，hook 不在 .git\hooks 下。
# 不先确认这个，"hook 不存在"的结论会是错的。
$repoHooksPath   = (git -C $repoRoot config --get core.hooksPath 2>$null) -join ""
$globalHooksPath = (git config --global --get core.hooksPath 2>$null) -join ""
$systemHooksPath = (git config --system --get core.hooksPath 2>$null) -join ""
Write-Output ("repo   core.hooksPath: " + $(if ($repoHooksPath)   { $repoHooksPath }   else { "(未设置)" }))
Write-Output ("global core.hooksPath: " + $(if ($globalHooksPath) { $globalHooksPath } else { "(未设置)" }))
Write-Output ("system core.hooksPath: " + $(if ($systemHooksPath) { $systemHooksPath } else { "(未设置)" }))
$effectiveHooksDir = (git -C $repoRoot rev-parse --git-path hooks 2>$null) -join ""
if ($effectiveHooksDir -and -not [System.IO.Path]::IsPathRooted($effectiveHooksDir)) {
    $effectiveHooksDir = Join-Path $repoRoot $effectiveHooksDir
}
Write-Output "实际生效 hooks 目录: $effectiveHooksDir"
if ($effectiveHooksDir -and (Test-Path $effectiveHooksDir)) {
    Get-ChildItem $effectiveHooksDir -ErrorAction SilentlyContinue |
        Select-Object -First 20 | Format-Table Name, Length, LastWriteTime
    foreach ($h in @("pre-commit", "post-commit")) {
        $hp = Join-Path $effectiveHooksDir $h
        if (Test-Path $hp) {
            # 非文本 hook（第三方工具的编译产物）插件会拒绝改写并跳过安装
            $bytes = [System.IO.File]::ReadAllBytes($hp) | Select-Object -First 4
            $isText = -not ($bytes -contains 0)
            $marker = (Select-String -Path $hp -Pattern "git-ai-kiro" -SimpleMatch -ErrorAction SilentlyContinue | Measure-Object).Count
            Write-Output "$h  文本文件: $isText  含 git-ai-kiro marker: $marker  大小: $((Get-Item $hp).Length)"
        }
    }
} else {
    Write-Output "(生效 hooks 目录不存在)"
}
Write-Output ""

Write-Output "=== 3b. Hook 文件内容 (.git\hooks 下) ==="
$preHook = "$repoRoot\.git\hooks\pre-commit"
$postHook = "$repoRoot\.git\hooks\post-commit"
Write-Output "--- pre-commit ---"
if (Test-Path $preHook) {
    Get-Item $preHook | Format-List FullName, Length, LastWriteTime
    Write-Output "--- 内容 ---"
    Get-Content $preHook
} else {
    Write-Output "(不存在)"
}
Write-Output ""
Write-Output "--- post-commit ---"
if (Test-Path $postHook) {
    Get-Item $postHook | Format-List FullName, Length, LastWriteTime
    Write-Output "--- 内容 (前 200 行) ---"
    Get-Content $postHook -TotalCount 200
} else {
    Write-Output "(不存在)"
}
Write-Output ""

Write-Output "=== 4. .git/ai 目录 ==="
$aiDir = "$repoRoot\.git\ai"
if (Test-Path $aiDir) {
    Get-ChildItem $aiDir | Format-Table Name, Length, LastWriteTime
    Write-Output ""
    Write-Output "--- working_logs ---"
    Get-ChildItem "$aiDir\working_logs" -ErrorAction SilentlyContinue | Select-Object -First 20 | Format-Table Name, LastWriteTime
} else {
    Write-Output "(不存在)"
}
Write-Output ""

Write-Output "=== 5. 最近 20 条 stats / userSync 上报记录 ==="
$payloadFile = "$repoRoot\.git\ai\last_upload_payload.json"
if (Test-Path $payloadFile) {
    Get-Item $payloadFile | Format-List FullName, Length, LastWriteTime
    Write-Output ""
    Write-Output "--- 最近 20 条记录 ---"
    $content = Get-Content $payloadFile -Raw -ErrorAction SilentlyContinue
    $matches = [regex]::Matches($content, '\[(stats|userSync)\] \[[^\]]*\] \{[^}]*\}')
    $tail = if ($matches.Count -ge 20) { $matches[($matches.Count - 20)..($matches.Count - 1)] } else { $matches }
    foreach ($m in $tail) { Write-Output $m.Value }
} else {
    Write-Output "(不存在)"
}
Write-Output ""

Write-Output "=== 6. post_commit_debug.log (最后 5 个 commit 的 debug 信息) ==="
$debugLog = "$repoRoot\.git\ai\post_commit_debug.log"
if (Test-Path $debugLog) {
    Get-Item $debugLog | Format-List FullName, Length, LastWriteTime
    Write-Output ""
    $content = Get-Content $debugLog -Raw -ErrorAction SilentlyContinue
    $blocks = [regex]::Matches($content, '(?ms)^--- \d+ ---.*?(?=^--- \d+ ---|\z)')
    $start = [Math]::Max(0, $blocks.Count - 5)
    for ($i = $start; $i -lt $blocks.Count; $i++) { Write-Output $blocks[$i].Value }
} else {
    Write-Output "(不存在)"
}
Write-Output ""

Write-Output "=== 7. Workspace 中的 git repo 清单 ==="
$workspaceParent = Split-Path $repoRoot -Parent
Write-Output "搜索 $workspaceParent 下的 git repo (最多 3 层)"
Get-ChildItem $workspaceParent -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
    Where-Object { Test-Path "$($_.FullName)\.git" } |
    Select-Object -First 30 -ExpandProperty FullName
Write-Output ""

Write-Output "=== 8. 最近一次 commit 的 git note ==="
$latestSha = (git -C $repoRoot rev-parse HEAD 2>$null) -join ""
if ($latestSha) {
    Write-Output "Commit: $latestSha"
    $note = git -C $repoRoot notes --ref=ai show $latestSha 2>$null
    if ($note) { Write-Output $note } else { Write-Output "(无 ai note)" }
}
Write-Output ""

Write-Output "=== 8b. note 是否能被当前二进制解析 (AI 行被算成 human 的隐蔽根因) ==="
# note 内容看起来正常但读取侧解析失败时，AI 归因会被整份丢弃、全部计入 human。
# 诱因通常是客户机上装过更新版 git-ai，它写的 note 含本版本不识别的结构。
if ($gitAiDir -and $latestSha) {
    $gitAiBin = Join-Path $gitAiDir "bin\git-ai.exe"
    if (Test-Path $gitAiBin) {
        Write-Output "--- stats stderr (关注 'could not be parsed') ---"
        Push-Location $repoRoot
        & $gitAiBin stats $latestSha --json 2>&1 1>$null | Select-Object -First 10
        Pop-Location
    }
}
Write-Output "--- 各 note 是由哪个 git-ai 版本写的 (版本混用是诱因) ---"
$noteShas = (git -C $repoRoot notes --ref=ai list 2>$null) | ForEach-Object { ($_ -split '\s+')[1] } | Select-Object -First 40
$noteShas | ForEach-Object {
    $n = git -C $repoRoot notes --ref=ai show $_ 2>$null
    if ($n) { ($n | Select-String -Pattern '"git_ai_version": "[^"]*"').Matches.Value }
} | Group-Object | Sort-Object Count -Descending | Format-Table Count, Name
Write-Output ""

Write-Output "=== 8c. Kiro 1.0 会话日志 (Format C 数据源) ==="
# 旧版 Kiro 写 globalStorage 下的 execution log；Kiro 1.0 改到这里。
# 客户升级 Kiro 后若插件不支持 Format C，会表现为"AI 数据突然全断"。
$kiroSessions = "$env:USERPROFILE\.kiro\sessions"
if (Test-Path $kiroSessions) {
    Write-Output "存在: $kiroSessions  -> 数据源可能是 Format C"
    Write-Output "--- 会话目录 (跳过 cli，那是 Kiro CLI 的会话) ---"
    Get-ChildItem $kiroSessions -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Get-ChildItem $_.FullName -Directory -Filter "sess_*" -ErrorAction SilentlyContinue
    } | Where-Object { $_.FullName -notmatch '\\cli\\' } | Select-Object -First 10 | ForEach-Object {
        $sdir = $_.FullName
        Write-Output "[$sdir]"
        $mj = Join-Path $sdir "messages.jsonl"
        if (Test-Path $mj) {
            # 体积很关键：超上限的会话会被整份静默跳过
            Write-Output ("  messages.jsonl 大小: " + (Get-Item $mj).Length + " bytes")
            Write-Output ("  行数: " + (Get-Content $mj -ErrorAction SilentlyContinue | Measure-Object -Line).Lines)
        } else {
            Write-Output "  (无 messages.jsonl —— 该会话不会被采集)"
        }
        # workspacePaths 决定归属，Windows 上盘符大小写/分隔符不一致会导致匹配失败
        $sj = Join-Path $sdir "session.json"
        if (Test-Path $sj) {
            try {
                $obj = Get-Content $sj -Raw | ConvertFrom-Json
                Write-Output ("  workspacePaths: " + ($obj.workspacePaths -join ", "))
                Write-Output ("  lastModifiedAt: " + $obj.lastModifiedAt)
            } catch { Write-Output "  (session.json 解析失败)" }
        } else {
            Write-Output "  (无 session.json —— 无法判定归属哪个 workspace)"
        }
    }
} else {
    Write-Output "(不存在 $kiroSessions -> 数据源应为旧版 execution log / Format A/B)"
}
Write-Output ""
Write-Output "--- 旧版 execution log 目录 (Format A/B) ---"
$execLogRoot = "$env:APPDATA\Kiro\User\globalStorage\kiro.kiroagent"
if (Test-Path $execLogRoot) {
    Get-ChildItem $execLogRoot -Directory -Recurse -Depth 1 -ErrorAction SilentlyContinue |
        Select-Object -First 10 -ExpandProperty FullName
} else {
    Write-Output "(不存在)"
}
Write-Output ""

Write-Output "=== 9. 最近的 q-client.log (如有) ==="
$qlogDir = "$env:APPDATA\Kiro\logs"
if (Test-Path $qlogDir) {
    $latestQlog = Get-ChildItem $qlogDir -Recurse -Filter "q-client.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestQlog) {
        Write-Output "Log file: $($latestQlog.FullName)"
        Write-Output "--- 最后 30 行 ---"
        Get-Content $latestQlog.FullName -Tail 30
    }
}
Write-Output ""

Write-Output "=== 10. Curl 可用性 ==="
$systemCurl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if ($systemCurl) { Write-Output "系统 curl: $systemCurl"; & $systemCurl --version | Select-Object -First 1 }
else { Write-Output "(系统 curl 不可用)" }
if ($gitAiDir -and (Test-Path "$gitAiDir\bin\curl.exe")) {
    Write-Output "插件 bundled curl.exe: $gitAiDir\bin\curl.exe"
    Get-Item "$gitAiDir\bin\curl.exe" | Format-List FullName, Length
}
Write-Output ""

Write-Output "=== 11. sh.exe 可用性 ==="
$shCandidates = @(
    "C:\Program Files\Git\bin\sh.exe",
    "C:\Program Files\Git\usr\bin\sh.exe",
    "C:\Program Files (x86)\Git\bin\sh.exe"
)
foreach ($p in $shCandidates) {
    if (Test-Path $p) { Write-Output "Found: $p" }
}
$gitExecPath = (git --exec-path 2>$null) -join ""
if ($gitExecPath) { Write-Output "git --exec-path: $gitExecPath" }
Write-Output ""

Write-Output "==========================================="
Write-Output "诊断信息收集完成"
Write-Output "==========================================="
