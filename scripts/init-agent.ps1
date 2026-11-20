<#
  NanHuInfer — 初始化项目级 pi agent 目录
  ⚠️ 请在 Trae 外部的 PowerShell / Windows Terminal 执行此脚本（Trae 沙箱禁止在全局 ~/.pi/agent 下 mkdir）

  功能:
    1. 创建 .pi/agent/ 目录（避开 Trae 沙箱对全局 ~/.pi/agent 的 mkdir 限制）
    2. 从全局 ~/.pi/agent 复制 settings.json / auth.json / models.json 等配置文件
    3. 创建 junction 链接 .pi/agent/npm -> ~/.pi/agent/npm（避免复制 160MB+ 的 node_modules）
    4. 把项目级 settings.json（有 bridge 配置）写入 .pi/agent/settings.json
#>
$ErrorActionPreference = "Stop"

$piDir      = Split-Path $PSScriptRoot -Parent
$repoRoot   = Split-Path $piDir -Parent
$agentDir   = Join-Path $piDir "agent"
$globalAgent = Join-Path $env:USERPROFILE ".pi\agent"

Write-Host "=== NanHuInfer Agent 目录初始化 ===" -ForegroundColor Cyan
Write-Host "  项目 agent:  $agentDir" -ForegroundColor DarkGray
Write-Host "  全局 agent:  $globalAgent" -ForegroundColor DarkGray
Write-Host ""

# —— 1. 创建目录 ——
if (-not (Test-Path $agentDir)) {
    New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
    Write-Host "[1/4] 创建目录: $agentDir" -ForegroundColor Green
} else {
    Write-Host "[1/4] 目录已存在，跳过" -ForegroundColor DarkGray
}

# —— 2. 复制配置文件 ——
$copied = 0
foreach ($item in @("settings.json", "auth.json", "models.json", "models-store.json")) {
    $src = Join-Path $globalAgent $item
    $dst = Join-Path $agentDir $item
    if (Test-Path $src) {
        # 如果目标已存在，先备份
        if ((Test-Path $dst) -and $item -eq "settings.json") {
            # settings.json 由项目级覆盖，跳过
            continue
        }
        Copy-Item $src $dst -Force
        $copied++
    }
}
Write-Host "[2/4] 已复制 $copied 个配置文件（settings.json 由项目级覆盖）" -ForegroundColor Green

# —— 3. 创建 junction 链接 npm ——
$npmLink = Join-Path $agentDir "npm"
$npmGlobal = Join-Path $globalAgent "npm"
if (-not (Test-Path $npmLink)) {
    if (-not (Test-Path $npmGlobal)) {
        Write-Host "[3/4] 警告: 全局 npm 目录不存在: $npmGlobal" -ForegroundColor Yellow
    } else {
        New-Item -ItemType Junction -Path $npmLink -Target $npmGlobal | Out-Null
        Write-Host "[3/4] 创建 junction: $npmLink -> $npmGlobal" -ForegroundColor Green
    }
} else {
    Write-Host "[3/4] npm 已存在，跳过" -ForegroundColor DarkGray
}

# —— 4. 写入项目级 settings.json（包含 bridge 配置）——
$projectSettings = Join-Path $piDir "settings.json"
$agentSettings   = Join-Path $agentDir "settings.json"
if (Test-Path $projectSettings) {
    Copy-Item $projectSettings $agentSettings -Force
    Write-Host "[4/4] 已写入项目级 settings.json（含 bridge 配置）" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== 初始化完成 ===" -ForegroundColor Cyan
Write-Host "现在可以启动 pi-server:" -ForegroundColor White
Write-Host "  cd $repoRoot" -ForegroundColor DarkGray
Write-Host '  .\.pi\scripts\start.ps1' -ForegroundColor DarkGray
