<#
  NanHuInfer PI Server — 停止（Windows）

  读取 .pi/channel-sessions/pi-server.pid → 优雅终止
#>
$ErrorActionPreference = "Stop"

$piDir      = Split-Path $PSScriptRoot -Parent
$sessionDir = Join-Path $piDir "channel-sessions"
$pidFile    = Join-Path $sessionDir "pi-server.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "[stop] PID 文件不存在: $pidFile（可能没在运行）" -ForegroundColor Yellow
    exit 0
}

$pid = (Get-Content $pidFile).Trim()
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue

if (-not $proc) {
    Write-Host "[stop] PID=$pid 不存在，清理 PID 文件" -ForegroundColor Yellow
    Remove-Item $pidFile -Force
    exit 0
}

# —— 优雅终止（先 SIGTERM，再 SIGKILL） ——
Write-Host "[stop] 正在停止 pi-server (PID=$pid)..." -ForegroundColor Cyan
try {
    Stop-Process -Id $pid -Force -ErrorAction Stop
} catch {
    Write-Host "[stop] Stop-Process 失败: $_" -ForegroundColor Red
}

# —— 等待进程真正消失 ——
for ($i = 0; $i -lt 10; $i++) {
    if (-not (Get-Process -Id $pid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 300
}

if (Get-Process -Id $pid -ErrorAction SilentlyContinue) {
    Write-Host "[stop] 进程仍存活，强制终止..." -ForegroundColor Yellow
    Stop-Process -Id $pid -Force
}

Remove-Item $pidFile -Force
Write-Host "[stop] pi-server 已停止" -ForegroundColor Green
