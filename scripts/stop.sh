#!/usr/bin/env bash
# 停止 start.sh 启动的 pi RPC 服务
#
# sidecar 托管模式（默认）：向 sidecar 发 SIGTERM 并写入停止标记文件
# （标记文件是 Windows 等无法投递信号平台的主机制，Linux 下作双保险），
# sidecar 负责有序停止 pi 子进程、从注册中心注销并清理 pid/管道文件。
#
# 直启模式（PI_SIDECAR_ENABLED=0）：直接对 pi 进程走 SIGTERM → 超时 SIGKILL。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SESS_DIR="$PI_DIR/sessions"
PID_FILE="$SESS_DIR/pi-rpc.pid"
FIFO_FILE="$SESS_DIR/pi-rpc.fifo"
SIDECAR_PID_FILE="$SESS_DIR/pi-sidecar.pid"
SIDECAR_STOP_FILE="$SESS_DIR/pi-sidecar.stop"

# 优雅退出等待秒数
TIMEOUT="${PI_STOP_TIMEOUT:-15}"

log() { printf '[stop] %s\n' "$*"; }

read_pid() {
  local p
  p="$(cat "$1" 2>/dev/null || true)"
  case "$p" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "$p" ;;
  esac
}

pid_alive() {
  [ "$1" -gt 0 ] && kill -0 "$1" 2>/dev/null
}

cleanup_files() {
  rm -f "$PID_FILE" "$FIFO_FILE" "$SIDECAR_PID_FILE" "$SIDECAR_STOP_FILE"
}

# ── sidecar 托管模式 ────────────────────────────────────────
SC_PID="$(read_pid "$SIDECAR_PID_FILE")"
if [ "$SC_PID" -gt 0 ] && pid_alive "$SC_PID"; then
  log "正在停止 sidecar (pid $SC_PID)，由其有序停止 pi 子进程并从注册中心注销..."
  touch "$SIDECAR_STOP_FILE"
  kill -TERM "$SC_PID" 2>/dev/null || true

  i=0
  while [ "$i" -lt "$TIMEOUT" ]; do
    pid_alive "$SC_PID" || break
    sleep 1
    i=$((i + 1))
  done

  if pid_alive "$SC_PID"; then
    log "等待 ${TIMEOUT}s 仍未退出，强制结束 sidecar"
    kill -KILL "$SC_PID" 2>/dev/null || true
    sleep 1
    # sidecar 被强杀时可能遗留 pi 子进程，兜底清理
    RPC_PID="$(read_pid "$PID_FILE")"
    if pid_alive "$RPC_PID"; then
      log "清理遗留的 pi 子进程 (pid $RPC_PID)..."
      kill -TERM "$RPC_PID" 2>/dev/null || true
      j=0
      while [ "$j" -lt 5 ]; do
        pid_alive "$RPC_PID" || break
        sleep 1
        j=$((j + 1))
      done
      pid_alive "$RPC_PID" && kill -KILL "$RPC_PID" 2>/dev/null || true
    fi
  fi

  cleanup_files
  log "已停止 sidecar (pid $SC_PID) 与 pi"
  exit 0
fi

# ── 直启模式（旧版脚本直接启动 pi） ─────────────────────────
if [ "$SC_PID" -gt 0 ]; then
  rm -f "$SIDECAR_PID_FILE" "$SIDECAR_STOP_FILE"
fi

if [ ! -f "$PID_FILE" ]; then
  log "未找到 $PID_FILE，pi 可能未运行"
  exit 0
fi

PID="$(read_pid "$PID_FILE")"
if [ "$PID" -le 0 ]; then
  rm -f "$PID_FILE"
  log "pid 文件内容无效，已清理"
  exit 0
fi

if ! pid_alive "$PID"; then
  rm -f "$PID_FILE" "$FIFO_FILE"
  log "进程 $PID 不存在，已清理残留文件"
  exit 0
fi

# SIGTERM 触发 pi 有序退出，给正在进行的任务收尾时间
log "正在停止 pi (pid $PID)..."
kill -TERM "$PID" 2>/dev/null || true

i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  pid_alive "$PID" || break
  sleep 1
  i=$((i + 1))
done

if pid_alive "$PID"; then
  log "等待 ${TIMEOUT}s 仍未退出，强制结束"
  kill -KILL "$PID" 2>/dev/null || true
  sleep 1
fi

rm -f "$PID_FILE" "$FIFO_FILE"
log "已停止 pi (pid $PID)"
