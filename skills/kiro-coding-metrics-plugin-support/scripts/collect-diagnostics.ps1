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

Write-Output "=== 3. Hook 文件 ==="
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
