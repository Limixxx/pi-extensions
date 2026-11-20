<#
.SYNOPSIS
  停止 start.ps1 启动的 pi RPC 进程。
.DESCRIPTION
  stop.sh 的 Windows PowerShell 版本。先结束 keeper（其退出即关闭 pi 的 stdin，
  触发 pi 有序退出），等待超时后再用 taskkill /T /F 结束整个进程树。
  可用环境变量 PI_STOP_TIMEOUT 调整等待秒数，默认 15。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PiDir     = Split-Path -Parent $ScriptDir
$SessDir   = Join-Path $PiDir 'sessions'
$PidFile   = Join-Path $SessDir 'pi-rpc.pid'
$InfoFile  = Join-Path $SessDir 'pi-rpc.info'

$TimeoutSec = 15
if ($env:PI_STOP_TIMEOUT) {
    $parsed = 0
    if ([int]::TryParse($env:PI_STOP_TIMEOUT, [ref]$parsed) -and $parsed -gt 0) { $TimeoutSec = $parsed }
}

function Write-Log {
    param([string]$Message)
    Write-Host "[stop] $Message"
}

if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Log "未找到 $PidFile，pi 可能未运行"
    exit 0
}

$keeperPid = 0
[void][int]::TryParse((Get-Content -LiteralPath $PidFile -TotalCount 1), [ref]$keeperPid)
if ($keeperPid -le 0) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Log 'pid 文件内容无效，已清理'
    exit 0
}

$piPid = 0
if (Test-Path -LiteralPath $InfoFile) {
    foreach ($line in Get-Content -LiteralPath $InfoFile) {
        if ($line -match '^pi_pid=(\d+)$') { $piPid = [int]$Matches[1] }
    }
}

$keeperAlive = [bool](Get-Process -Id $keeperPid -ErrorAction SilentlyContinue)
$piAlive = ($piPid -gt 0) -and [bool](Get-Process -Id $piPid -ErrorAction SilentlyContinue)

if (-not $keeperAlive -and -not $piAlive) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Log '进程不存在，已清理残留文件'
    exit 0
}

# 结束 keeper：pi 的 stdin 写端关闭，pi 走有序退出
if ($keeperAlive) {
    Write-Log "正在停止 pi (keeper pid $keeperPid)..."
    Stop-Process -Id $keeperPid -Force -ErrorAction SilentlyContinue
}

if ($piPid -gt 0) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Id $piPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Get-Process -Id $piPid -ErrorAction SilentlyContinue) {
        Write-Log "等待 ${TimeoutSec}s 仍未退出，强制结束进程树"
        & taskkill /PID $piPid /T /F 2>$null | Out-Null
    }
}

Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
Write-Log "已停止 pi (pid $piPid)"
