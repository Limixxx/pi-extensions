<#
.SYNOPSIS
  停止 start.ps1 启动的 pi RPC 服务。
.DESCRIPTION
  stop.sh 的 Windows PowerShell 版本。

  sidecar 托管模式（默认）：Windows 无法向进程投递可捕获的信号，因此写入
  停止标记文件 sessions/pi-sidecar.stop，sidecar 轮询到标记后自行有序停止
  pi 子进程、从注册中心注销并清理文件；等待超时则 taskkill /T /F 结束进程树。

  直启模式（PI_SIDECAR_ENABLED=0）：先结束 keeper（其退出即关闭 pi 的 stdin，
  触发 pi 有序退出），等待超时后再结束进程树。

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
$SidecarPidFile  = Join-Path $SessDir 'pi-sidecar.pid'
$SidecarStopFile = Join-Path $SessDir 'pi-sidecar.stop'

$TimeoutSec = 15
if ($env:PI_STOP_TIMEOUT) {
    $parsed = 0
    if ([int]::TryParse($env:PI_STOP_TIMEOUT, [ref]$parsed) -and $parsed -gt 0) { $TimeoutSec = $parsed }
}

function Write-Log {
    param([string]$Message)
    Write-Host "[stop] $Message"
}

function Read-PidFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $parsed = 0
    [void][int]::TryParse((Get-Content -LiteralPath $Path -TotalCount 1), [ref]$parsed)
    return $parsed
}

function Test-PidAlive {
    param([int]$ProcessId)
    return ($ProcessId -gt 0) -and [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# ── sidecar 托管模式 ───────────────────────────────────────
$sidecarPid = Read-PidFile $SidecarPidFile
if ($sidecarPid -gt 0 -and (Test-PidAlive $sidecarPid)) {
    Write-Log "正在停止 sidecar (pid $sidecarPid)，由其有序停止 pi 子进程并从注册中心注销..."
    # 停止标记：sidecar 轮询到后自行走优雅停止（Windows 无法投递可捕获信号）
    New-Item -ItemType File -Path $SidecarStopFile -Force | Out-Null

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-PidAlive $sidecarPid)) { break }
        Start-Sleep -Milliseconds 500
    }

    if (Test-PidAlive $sidecarPid) {
        Write-Log "等待 ${TimeoutSec}s 仍未退出，强制结束 sidecar 进程树"
        & taskkill /PID $sidecarPid /T /F 2>$null | Out-Null
        Start-Sleep -Milliseconds 500
        # sidecar 被强杀时可能遗留 pi 子进程，兜底清理
        $piPid = Read-PidFile $PidFile
        if (Test-PidAlive $piPid) {
            Write-Log "清理遗留的 pi 子进程 (pid $piPid)..."
            & taskkill /PID $piPid /T /F 2>$null | Out-Null
        }
    }

    Remove-Item -LiteralPath $SidecarPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $SidecarStopFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Log "已停止 sidecar (pid $sidecarPid) 与 pi"
    exit 0
}
if ($sidecarPid -gt 0) {
    Remove-Item -LiteralPath $SidecarPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $SidecarStopFile -Force -ErrorAction SilentlyContinue
}

# ── 直启模式（旧版脚本直接启动 pi） ─────────────────────────
if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Log "未找到 $PidFile，pi 可能未运行"
    exit 0
}

$keeperPid = Read-PidFile $PidFile
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

$keeperAlive = Test-PidAlive $keeperPid
$piAlive = Test-PidAlive $piPid

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
        if (-not (Test-PidAlive $piPid)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Test-PidAlive $piPid) {
        Write-Log "等待 ${TimeoutSec}s 仍未退出，强制结束进程树"
        & taskkill /PID $piPid /T /F 2>$null | Out-Null
    }
}

Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
Write-Log "已停止 pi (pid $piPid)"
