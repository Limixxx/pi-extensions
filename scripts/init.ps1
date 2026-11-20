<#
.SYNOPSIS
  初始化 pi 运行环境：安装 pi、安装 pi-feishu 扩展、更新扩展版本。
.DESCRIPTION
  init.sh 的 Windows PowerShell 版本，命令与行为保持一致。
  若本机执行策略限制脚本运行，可用：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\init.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PiDir     = Split-Path -Parent $ScriptDir
$FeishuPkg = 'npm:pi-feishu'

function Write-Log {
    param([string]$Message)
    Write-Host "[init] $Message"
}

function Write-Fail {
    param([string]$Message)
    Write-Host "[init] 错误: $Message" -ForegroundColor Red
    exit 1
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

# 2. npm:pi-feishu
function Test-FeishuInstalled {
    # 先查设置文件（快、无网络），再回落到 pi list
    $userHome = $env:USERPROFILE
    if (-not $userHome) { $userHome = [Environment]::GetFolderPath('UserProfile') }
    $files = @(
        (Join-Path $userHome '.pi\settings.json'),
        (Join-Path $userHome '.pi\agent\settings.json'),
        (Join-Path $PiDir 'settings.json')
    )
    foreach ($file in $files) {
        if ((Test-Path -LiteralPath $file) -and
            (Select-String -LiteralPath $file -Pattern 'pi-feishu' -SimpleMatch -Quiet)) {
            return $true
        }
    }
    $listed = & pi list 2>$null
    if ($listed -match 'pi-feishu') { return $true }
    return $false
}

if (Test-FeishuInstalled) {
    Write-Log "已安装扩展 $FeishuPkg"
} else {
    Write-Log "未检测到 $FeishuPkg，开始安装..."
    & pi install $FeishuPkg
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "安装 $FeishuPkg 失败 (exit $LASTEXITCODE)"
    }
}

# 3. 更新扩展版本
Write-Log "更新扩展 $FeishuPkg ..."
& pi update --extension $FeishuPkg
if ($LASTEXITCODE -ne 0) {
    Write-Fail "更新 $FeishuPkg 失败 (exit $LASTEXITCODE)"
}

# 4. 运行目录
New-Item -ItemType Directory -Force -Path (Join-Path $PiDir 'sessions') | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $PiDir '.env'))) {
    Write-Log '提示: 未找到 .env，可复制 .env.example 后填写（start.ps1 会自动加载）'
}

Write-Log '初始化完成'
