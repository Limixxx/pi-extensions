<#
  NanHuInfer PI Server — 后台启动（Windows）

  路径锚定:
    脚本    = .pi/scripts/start.ps1
    env     = .pi/.env
    agentDir= .pi/agent/（项目内，替代全局 ~/.pi/agent）
    sessions= .pi/channel-sessions/
    repoRoot= 脚本所在目录向上两级 (NanHuInfer/)

  产物:
    .pi/channel-sessions/pi-server.pid
    .pi/channel-sessions/pi-server.stdout.log
    .pi/channel-sessions/pi-server.stderr.log

  ⚠️ 首次使用前请在外部 PowerShell（非 Trae 内）执行:
      .\.pi\scripts\init-agent.ps1
     因为 Trae 沙箱禁止在全局 ~/.pi/agent 下 mkdir 及创建 junction
#>
$ErrorActionPreference = "Stop"

# —— 路径锚点 ——
$piDir        = Split-Path $PSScriptRoot -Parent
$repoRoot     = Split-Path $piDir -Parent
$dotEnvFile   = Join-Path $piDir ".env"
$agentDir     = Join-Path $piDir "agent"
$sessionDir   = Join-Path $piDir "channel-sessions"
$pidFile      = Join-Path $sessionDir "pi-server.pid"
$logStdout    = Join-Path $sessionDir "pi-server.stdout.log"
$logStderr    = Join-Path $sessionDir "pi-server.stderr.log"
$piServerCli  = "D:\agents\nodejs\node_cache\_npx\a46222b13c4fe41e\node_modules\@marcfargas\pi-server\dist\cli.js"

if (-not (Test-Path $sessionDir)) { New-Item -ItemType Directory -Path $sessionDir -Force | Out-Null }

# —— 检查已有进程 ——
if (Test-Path $pidFile) {
    $oldPid = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Host "[start] pi-server 已在运行 (PID=$oldPid)" -ForegroundColor Yellow
        exit 0
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# —— 检查项目级 agent 目录 ——
if (-not (Test-Path $agentDir)) {
    Write-Host "[start] 错误: 项目级 agent 目录不存在: $agentDir" -ForegroundColor Red
    Write-Host "        请先在 Trae 外部的 PowerShell 执行:" -ForegroundColor Yellow
    Write-Host "          cd D:\Work Space\github\nhcf\NanHuInfer" -ForegroundColor Yellow
    Write-Host "          .\.pi\scripts\init-agent.ps1" -ForegroundColor Yellow
    exit 1
}
[System.Environment]::SetEnvironmentVariable("PI_CODING_AGENT_DIR", $agentDir, "Process")
Write-Host "[start] PI_CODING_AGENT_DIR = $agentDir" -ForegroundColor DarkGray

# —— 加载 .env ——
$varsLoaded = 0
if (Test-Path $dotEnvFile) {
    Get-Content $dotEnvFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith('#')) { return }
        if ($line -match '^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$') {
            $key   = $Matches[1].Trim()
            $value = $Matches[2].Trim().Trim('"').Trim("'")
            [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
            $varsLoaded++
        }
    }
    Write-Host "[start] 已加载 $varsLoaded 个环境变量" -ForegroundColor Cyan
} else {
    Write-Host "[start] 警告: .env 文件不存在 ($dotEnvFile)，将使用当前环境" -ForegroundColor Yellow
}

# —— 清理旧的 channel session ——
$oldSessions = Get-ChildItem $sessionDir -Filter "feishu-*.jsonl" -ErrorAction SilentlyContinue
if ($oldSessions) {
    Remove-Item $oldSessions.FullName -Force
    Write-Host "[start] 已清理 $($oldSessions.Count) 个旧 channel-session" -ForegroundColor DarkGray
}

# —— 后台启动 ——
$nodePath = (Get-Command node.exe).Source
Write-Host "[start] node    = $nodePath" -ForegroundColor DarkGray
Write-Host "[start] CWD     = $repoRoot" -ForegroundColor DarkGray

if ($piServerCli -and (Test-Path $piServerCli)) {
    Write-Host "[start] cli     = $piServerCli" -ForegroundColor DarkGray
    $argList = @($piServerCli, "serve", "--port", "3141")
    $exe = $nodePath
} else {
    Write-Host "[start] cli     = (通过 npx 解析)" -ForegroundColor DarkGray
    $exe = "npx.cmd"
    $argList = @("pi-server", "serve", "--port", "3141")
}

$proc = Start-Process -FilePath $exe `
    -ArgumentList $argList `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $logStdout `
    -RedirectStandardError  $logStderr `
    -PassThru -WindowStyle Hidden

$proc.Id | Set-Content $pidFile

# —— 等一下确认进程没秒退 ——
Start-Sleep -Seconds 3
$alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if (-not $alive) {
    Write-Host "[start] 错误: 进程启动后立即退出" -ForegroundColor Red
    Write-Host "--- stdout ---"
    Get-Content $logStdout -ErrorAction SilentlyContinue
    Write-Host "--- stderr ---"
    Get-Content $logStderr -ErrorAction SilentlyContinue
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "[start] pi-server 已后台启动 (PID=$($proc.Id))" -ForegroundColor Green
Write-Host "[start] PID   = $pidFile"   -ForegroundColor DarkGray
Write-Host "[start] stdout = $logStdout" -ForegroundColor DarkGray
Write-Host "[start] stderr = $logStderr" -ForegroundColor DarkGray
Write-Host ""
Write-Host "查看日志: Get-Content $logStdout -Wait" -ForegroundColor DarkGray
Write-Host "停止服务: .\.pi\scripts\stop.ps1" -ForegroundColor DarkGray
