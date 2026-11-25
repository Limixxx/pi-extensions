<#
.SYNOPSIS
  初始化 pi 运行环境：安装 pi、安装必需扩展、更新扩展版本。
.DESCRIPTION
  init.sh 的 Windows PowerShell 版本，命令与行为保持一致。
  必需扩展列表与 ~/.pi/agent/settings.json 的 packages 保持一致（可通过 pi list 确认）。
  若本机执行策略限制脚本运行，可用：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\init.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PiDir     = Split-Path -Parent $ScriptDir

# —— 必需扩展（与 pi list 输出、~/.pi/agent/settings.json 的 packages 字段保持同步）——
# 新增或删除包时，先更新本机 pi install 再同步修改这里，保证脚本与实际依赖一致。
$RequiredPackages = @(
    'npm:pi-dsml',
    'git:github.com/Limixxx/pi-feishu@main',
    'git:github.com/Limixxx/pi-subagents@main'
)

function Write-Log {
    param([string]$Message)
    Write-Host "[init] $Message"
}

function Write-Fail {
    param([string]$Message)
    Write-Host "[init] 错误: $Message" -ForegroundColor Red
    exit 1
}

# 检查包是否已安装：用 pi list 按 source 精确匹配（pi list 会打印完整 source）
function Test-PackageInstalled {
    param([string]$Source)
    $listed = (& pi list 2>$null) -join "`n"
    return $listed -like "*$Source*"
}

# 1. pi
if (Get-Command pi -ErrorAction SilentlyContinue) {
    $version = (& pi --version 2>$null | Select-Object -Last 1)
    Write-Log "已安装 pi: $version"
} else {
    Write-Log '未检测到 pi，使用官方脚本安装...'
    & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://pi.dev/install.ps1 | iex"
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "pi 安装脚本执行失败 (exit $LASTEXITCODE)"
    }
    # 安装脚本只修改了用户环境变量，这里刷新当前进程的 PATH
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
        Write-Fail 'pi 安装完成但不在 PATH 中，请重新打开终端后重试'
    }
    $version = (& pi --version 2>$null | Select-Object -Last 1)
    Write-Log "pi 安装完成: $version"
}

# 2. 逐个安装缺失的必需扩展
foreach ($pkg in $RequiredPackages) {
    if (Test-PackageInstalled -Source $pkg) {
        Write-Log "已安装扩展 $pkg"
    } else {
        Write-Log "未检测到 $pkg，开始安装..."
        & pi install $pkg
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "安装 $pkg 失败 (exit $LASTEXITCODE)"
        }
    }
}

# 3. 更新所有必需扩展
foreach ($pkg in $RequiredPackages) {
    Write-Log "更新扩展 $pkg ..."
    & pi update --extension $pkg
    if ($LASTEXITCODE -ne 0) {
        Write-Log "警告: 更新 $pkg 失败（非致命，可能是网络或版本已是最新）"
    }
}

# 4. 运行目录
New-Item -ItemType Directory -Force -Path (Join-Path $PiDir 'sessions') | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $PiDir '.env'))) {
    Write-Log '提示: 未找到 .env，可复制 .env.example 后填写（start.ps1 会自动加载）'
}

Write-Log "初始化完成（pi + $($RequiredPackages.Count) 个扩展）"
