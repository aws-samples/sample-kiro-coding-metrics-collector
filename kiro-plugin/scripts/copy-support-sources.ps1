# 把核心源码复制到 kiro-plugin/support-sources/ 下，让 VSIX 携带源码用于客户支持时分析
# 与 skills/kiro-coding-metrics-plugin-support/references/code-lookup.md 列出的文件保持同步
#
# 在 vsce package 之前运行
#
# 用法: powershell -ExecutionPolicy Bypass -File scripts\copy-support-sources.ps1

$ErrorActionPreference = 'Stop'

# $PSScriptRoot 是当前 ps1 文件所在目录（PowerShell 3+ 支持），比 $MyInvocation 更稳定
$ScriptDir = $PSScriptRoot
$PluginRoot = Split-Path -Parent $ScriptDir
$ProjectRoot = Split-Path -Parent $PluginRoot
$Dest = Join-Path $PluginRoot 'support-sources'

Write-Host "Copying core source files to $Dest"

if (Test-Path $Dest) {
    Remove-Item -Recurse -Force $Dest
}

# 创建目标子目录（New-Item -Force 在目录已存在时不报错）
$null = New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'kiro-plugin\src')
$null = New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'git-ai-src\src\commands')
$null = New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'git-ai-src\src\authorship')
$null = New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'git-ai-src\src\git')

# TS 插件核心源码（与 code-lookup.md 模块 1/2/3 一致）
$TsFiles = @(
    'sessionLogWatcher.ts',
    'sessionLogParser.ts',
    'sessionLogScanner.ts',
    'checkpointPayload.ts',
    'repoRouter.ts',
    'workspacePathEncoder.ts',
    'gitUtils.ts',
    'checkpoint.ts',
    'apiConfig.ts',
    'userSync.ts',
    'qClientWatcher.ts',
    'extension.ts'
)
foreach ($f in $TsFiles) {
    $src = Join-Path $PluginRoot "src\$f"
    if (Test-Path $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $Dest "kiro-plugin\src\$f")
    }
}

# git-ai Rust 核心源码（与 code-lookup.md 模块 4 一致）
$RustFiles = @(
    @{ Src = 'src\commands\git_ai_handlers.rs';            Dest = 'src\commands' },
    @{ Src = 'src\authorship\post_commit.rs';              Dest = 'src\authorship' },
    @{ Src = 'src\authorship\rebase_authorship.rs';        Dest = 'src\authorship' },
    @{ Src = 'src\authorship\virtual_attribution.rs';      Dest = 'src\authorship' },
    @{ Src = 'src\authorship\attribution_tracker.rs';      Dest = 'src\authorship' },
    @{ Src = 'src\git\rewrite_log.rs';                     Dest = 'src\git' }
)
foreach ($entry in $RustFiles) {
    $src = Join-Path $ProjectRoot "git-ai-src\$($entry.Src)"
    $dst = Join-Path $Dest "git-ai-src\$($entry.Dest)"
    if (Test-Path $src) {
        Copy-Item -LiteralPath $src -Destination $dst
    }
}

# 加 README 说明这些文件的用途
# 用 single-quoted here-string @'...'@，PowerShell 不会做变量插值或反引号转义，最安全
$Readme = @'
# Support Sources

这个目录包含插件核心模块的源码副本，用于客户支持时的问题分析。

打包时由 `scripts/copy-support-sources.{sh,ps1}` 自动从主项目复制，与
`skills/kiro-coding-metrics-plugin-support/references/code-lookup.md` 列出的文件保持一致。

## 用途

- 客户机上插件安装后，这些文件位于 `<extension-dir>/support-sources/`
- 支持工程师可通过 `kiro-coding-metrics-plugin-support` skill 直接读取
- 不需要客户提供源码，也不需要工程师从 GitHub 拉取

## 包含范围

- `kiro-plugin/src/` — TypeScript 插件源码（SessionLogWatcher / Hook / userSync 等）
- `git-ai-src/src/` — git-ai Rust 后端核心模块

不包含 dashboard 服务端代码（不属于客户机插件）。

## 与代码同步

如修改了核心源码（如 `sessionLogWatcher.ts`），重新运行
`sh scripts/copy-support-sources.sh`（macOS/Linux）
或 `powershell -File scripts\copy-support-sources.ps1`（Windows）后再打包 VSIX。
'@

# 用 UTF8 写入（PS 5.1 上会带 BOM；不影响 markdown 阅读）
Set-Content -LiteralPath (Join-Path $Dest 'README.md') -Value $Readme -Encoding UTF8

# 统计复制的文件
Write-Host ''
$Files = @(Get-ChildItem -Path $Dest -Recurse -File | Where-Object { $_.Extension -in '.ts', '.rs' })
Write-Host "Copied $($Files.Count) source files to $Dest"
foreach ($f in $Files) {
    $rel = $f.FullName.Substring($Dest.Length + 1)
    Write-Host $rel
}
