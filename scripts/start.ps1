<#
.SYNOPSIS
  后台启动 pi RPC 服务（默认经 sidecar 守护进程托管）
.DESCRIPTION
  start.sh 的 Windows PowerShell 版本。pid、启动信息与日志写入 .pi/sessions/。

  PI_SIDECAR_ENABLED≠0（默认）：拉起 extensions/sidecar/sidecar.mjs 守护进程。
  Windows 无 FIFO，pi 的 stdin 由 sidecar 持有并通过命名管道
  pi-rpc-<sha1(workdir)[:6]> 转发命令；pi 崩溃由 sidecar 自动重启。

  PI_SIDECAR_ENABLED=0：跳过 sidecar，走旧版 keeper 直启流程。
#>
[CmdletBinding()]
param(
    [switch]$Keeper
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PiDir     = Split-Path -Parent $ScriptDir
$WorkDir   = Split-Path -Parent $PiDir
$SessDir   = Join-Path $PiDir 'sessions'
$PidFile   = Join-Path $SessDir 'pi-rpc.pid'
$InfoFile  = Join-Path $SessDir 'pi-rpc.info'
$LogFile   = Join-Path $SessDir 'pi-rpc.log'
$ErrFile   = Join-Path $SessDir 'pi-rpc.err.log'
$WebInfoFile = Join-Path $SessDir 'pi-web.info'
$SidecarEntry   = Join-Path $PiDir 'extensions\sidecar\sidecar.mjs'
$SidecarPidFile = Join-Path $SessDir 'pi-sidecar.pid'
$SidecarInfoFile = Join-Path $SessDir 'pi-sidecar.info'
$SidecarLogFile = Join-Path $SessDir 'pi-sidecar.log'
$SidecarOutLogFile = Join-Path $SessDir 'pi-sidecar.out.log'
$SidecarStopFile = Join-Path $SessDir 'pi-sidecar.stop'

# 命名管道按工作目录区分，避免多项目互相冲突
$sha = [System.Security.Cryptography.SHA1]::Create()
$digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($WorkDir.ToLowerInvariant()))
$sha.Dispose()
$PipeName = 'pi-rpc-' + (-join ($digest[0..5] | ForEach-Object { $_.ToString('x2') } ))

function Write-Log {
    param([string]$Message)
    Write-Host "[start] $Message"
}

function Write-Fail {
    param([string]$Message)
    Write-Host "[start] 错误: $Message" -ForegroundColor Red
    exit 1
}

# 解析 .env（shell export 语法），写入当前进程环境变量，供子进程继承
function Import-DotEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    foreach ($raw in Get-Content -LiteralPath $Path) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $line = $line -replace '^export\s+', ''
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { continue }
        $name = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
        Set-Item -Path "Env:$name" -Value $value
    }
}

function Read-PidFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $parsed = 0
    [void][int]::TryParse((Get-Content -LiteralPath $Path -TotalCount 1), [ref]$parsed)
    return $parsed
}

function Wait-WebInfo {
    $webDeadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $webDeadline) {
        if (Test-Path -LiteralPath $WebInfoFile) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Test-Path -LiteralPath $WebInfoFile) {
        $webUrl = (Get-Content -LiteralPath $WebInfoFile | Where-Object { $_ -match '^url=' }) -replace '^url=', ''
        if ($webUrl) { Write-Log "进程管理界面: $webUrl"; return }
    }
    Write-Log '进程管理界面: 未启动（可用 PI_WEB_ENABLED/PI_WEB_PORT 控制，见 .env.example）'
}

# ──────────────────────────────────────────────────────────
# keeper：旧版直启模式的 stdin 持有进程（PI_SIDECAR_ENABLED=0 时使用）
# ──────────────────────────────────────────────────────────
if ($Keeper) {
    try {
        Import-DotEnv (Join-Path $PiDir '.env')
        New-Item -ItemType Directory -Force -Path $SessDir | Out-Null

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $env:ComSpec
        $psi.Arguments = '/d /s /c "pi --mode rpc --approve"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = $WorkDir
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $proc = [System.Diagnostics.Process]::Start($psi)

        # bufferSize=1：不缓冲，日志随写随落盘，便于外部实时 tail
        $logStream = [System.IO.FileStream]::new($LogFile, [System.IO.FileMode]::Append,
            [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read, 1)
        $errStream = [System.IO.FileStream]::new($ErrFile, [System.IO.FileMode]::Append,
            [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read, 1)
        $null = $proc.StandardOutput.BaseStream.CopyToAsync($logStream)
        $null = $proc.StandardError.BaseStream.CopyToAsync($errStream)

        @(
            "pid=$PID"
            "pi_pid=$($proc.Id)"
            "started_at=$((Get-Date).ToString('s'))"
            "workdir=$WorkDir"
            "pipe=$PipeName"
            "stdout_log=$LogFile"
            "stderr_log=$ErrFile"
        ) | Set-Content -LiteralPath $InfoFile -Encoding UTF8

        # 一次服务一个客户端：接到连接后把字节原样写入 pi 的 stdin，直到客户端断开
        while (-not $proc.HasExited) {
            $server = [System.IO.Pipes.NamedPipeServerStream]::new(
                $PipeName,
                [System.IO.Pipes.PipeDirection]::In,
                1,
                [System.IO.Pipes.PipeTransmissionMode]::Byte,
                [System.IO.Pipes.PipeOptions]::None)
            $waitTask = $server.WaitForConnectionAsync()
            while (-not $waitTask.Wait(500)) {
                if ($proc.HasExited) { break }
            }
            if ($proc.HasExited) {
                $server.Dispose()
                break
            }
            try {
                $server.CopyTo($proc.StandardInput.BaseStream)
                $proc.StandardInput.BaseStream.Flush()
            } catch {
                # pi 已退出或连接被中断，回到等待下一个客户端
            } finally {
                $server.Dispose()
            }
        }

        $proc.WaitForExit()
        Start-Sleep -Milliseconds 300
        $logStream.Flush()
        $errStream.Flush()
        $logStream.Dispose()
        $errStream.Dispose()
    } catch {
        "[keeper] $($_.Exception.Message)" | Add-Content -LiteralPath $ErrFile -Encoding UTF8
        exit 1
    }
    exit 0
}

# ──────────────────────────────────────────────────────────
# 启动入口
# ──────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $SessDir | Out-Null

$SidecarEnabled = 1
if ($env:PI_SIDECAR_ENABLED) {
    switch -Regex ($env:PI_SIDECAR_ENABLED.ToLowerInvariant()) {
        '^(0|false|no|off)$' { $SidecarEnabled = 0 }
    }
}

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
    Write-Fail "未找到 pi，请先执行 $(Join-Path $ScriptDir 'init.ps1')"
}

Import-DotEnv (Join-Path $PiDir '.env')

# 清理上次运行残留的 Web 管理界面信息（正常退出时会由扩展自行清理）
Remove-Item -LiteralPath $WebInfoFile -Force -ErrorAction SilentlyContinue

# ── sidecar 托管模式 ───────────────────────────────────────
if ($SidecarEnabled -eq 1) {
    $oldSidecarPid = Read-PidFile $SidecarPidFile
    if ($oldSidecarPid -gt 0 -and (Get-Process -Id $oldSidecarPid -ErrorAction SilentlyContinue)) {
        Write-Log "sidecar 已在运行 (pid $oldSidecarPid)，无需重复启动"
        exit 0
    }
    Remove-Item -LiteralPath $SidecarPidFile -Force -ErrorAction SilentlyContinue

    # pi 已由旧版脚本直接启动时 sidecar 会自行拒绝接管，这里提前给出提示
    $oldPid = Read-PidFile $PidFile
    if ($oldPid -gt 0 -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Fail "pi 已在运行 (pid $oldPid，可能由旧版脚本直接启动)。请先执行 $(Join-Path $ScriptDir 'stop.ps1') 再切换到 sidecar 托管"
    }

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Fail '未找到 node，sidecar 守护依赖 node（或设置 PI_SIDECAR_ENABLED=0 回退直启）'
    }

    Remove-Item -LiteralPath $SidecarStopFile -Force -ErrorAction SilentlyContinue
    Write-Log '启动 sidecar 守护进程（配置见 .env.example 的 PI_SIDECAR_* 说明）...'
    $sidecarProc = Start-Process -FilePath 'node' -ArgumentList "`"$SidecarEntry`"" `
        -WorkingDirectory $WorkDir -WindowStyle Hidden `
        -RedirectStandardOutput $SidecarOutLogFile -RedirectStandardError $SidecarLogFile -PassThru
    Set-Content -LiteralPath $SidecarPidFile -Value $sidecarProc.Id -Encoding ASCII

    Start-Sleep -Seconds 2
    if ($sidecarProc.HasExited) {
        Remove-Item -LiteralPath $SidecarPidFile -Force -ErrorAction SilentlyContinue
        Write-Log 'sidecar 启动失败，最近的错误输出：'
        if (Test-Path -LiteralPath $SidecarLogFile) {
            Get-Content -LiteralPath $SidecarLogFile -Tail 20 | Write-Host
        }
        exit 1
    }

    Write-Log "sidecar 已启动 (pid $($sidecarProc.Id))，由其拉起并守护 pi RPC 子进程"
    if (Test-Path -LiteralPath $SidecarInfoFile) {
        foreach ($line in Get-Content -LiteralPath $SidecarInfoFile) {
            switch -Regex ($line) {
                '^mode='         { Write-Log ("运行模式: " + $line.Substring(5)) }
                '^node_id='      { Write-Log ("节点 ID: " + $line.Substring(8)) }
                '^registry_url=' { Write-Log ("注册中心: " + $line.Substring(13)) }
                '^master_url='   { Write-Log ("master: " + $line.Substring(11)) }
            }
        }
    }
    Write-Log "sidecar 日志: $SidecarLogFile"
    Write-Log '节点查询: pi_registry 工具（list/get/self）或 /sidecar 命令'
    Write-Log "停止: $(Join-Path $ScriptDir 'stop.ps1')"

    # 等待 sidecar 拉起 pi 子进程并写出 pid 文件
    $rpcDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $rpcDeadline) {
        if ((Test-Path -LiteralPath $PidFile) -or $sidecarProc.HasExited) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Test-Path -LiteralPath $PidFile) {
        Write-Log "pi RPC 子进程: pid $(Read-PidFile $PidFile)，进程信息: $InfoFile"
    } else {
        Write-Log "警告: 15s 内未见 pi 子进程 pid 文件，请检查 $SidecarLogFile"
    }

    Wait-WebInfo
    exit 0
}

# ── 直启模式（PI_SIDECAR_ENABLED=0，旧版 keeper） ───────────
if (-not (Get-Command 'pi.cmd' -ErrorAction SilentlyContinue)) {
    Write-Fail '未找到 pi.cmd，后台 RPC 启动依赖 cmd 版启动垫片'
}

if (Test-Path -LiteralPath $PidFile) {
    $oldPid = Read-PidFile $PidFile
    if ($oldPid -gt 0 -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Log "pi 已在运行 (pid $oldPid)，无需重复启动"
        exit 0
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

$psExe = (Get-Process -Id $PID).Path
if (-not $psExe -or $psExe -match 'ise\.exe$') {
    $psExe = Join-Path $PSHOME 'powershell.exe'
}

Remove-Item -LiteralPath $InfoFile -Force -ErrorAction SilentlyContinue

$argLine = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Keeper"
$keeperInfo = [System.Diagnostics.ProcessStartInfo]::new()
$keeperInfo.FileName = $psExe
$keeperInfo.Arguments = $argLine
$keeperInfo.UseShellExecute = $true
$keeperInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$keeperProc = [System.Diagnostics.Process]::Start($keeperInfo)
Set-Content -LiteralPath $PidFile -Value $keeperProc.Id -Encoding ASCII

# 等 keeper 拉起 pi 并写出启动信息
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    if ($keeperProc.HasExited) { break }
    if (Test-Path -LiteralPath $InfoFile) { break }
    Start-Sleep -Milliseconds 300
}

function Show-StartupFailure {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Log '启动失败，最近的错误输出：'
    if (Test-Path -LiteralPath $ErrFile) {
        Get-Content -LiteralPath $ErrFile -Tail 20 | Write-Host
    }
    exit 1
}

if (-not (Test-Path -LiteralPath $InfoFile)) { Show-StartupFailure }

$info = @{}
foreach ($line in Get-Content -LiteralPath $InfoFile) {
    $idx = $line.IndexOf('=')
    if ($idx -gt 0) { $info[$line.Substring(0, $idx)] = $line.Substring($idx + 1) }
}

$piPid = 0
if ($info.ContainsKey('pi_pid')) { [void][int]::TryParse($info['pi_pid'], [ref]$piPid) }

# 等 pi 进入 RPC 循环后再判定存活
Start-Sleep -Seconds 2
$keeperExited = $keeperProc.HasExited
$piAlive = ($piPid -gt 0) -and [bool](Get-Process -Id $piPid -ErrorAction SilentlyContinue)
if ($keeperExited -or -not $piAlive) { Show-StartupFailure }

Write-Log "pi RPC 已启动 (pid $piPid)"
Write-Log "工作目录: $WorkDir"
Write-Log "命令管道: \\.\pipe\$PipeName"
Write-Log "输出日志: $LogFile"
Write-Log "错误日志: $ErrFile"
Write-Log "进程信息: $InfoFile"
Write-Log "停止: $(Join-Path $ScriptDir 'stop.ps1')"

Wait-WebInfo
