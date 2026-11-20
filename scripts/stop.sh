#!/usr/bin/env bash
# 停止 start.sh 启动的 pi RPC 进程
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SESS_DIR="$PI_DIR/sessions"
PID_FILE="$SESS_DIR/pi-rpc.pid"
FIFO_FILE="$SESS_DIR/pi-rpc.fifo"

# 优雅退出等待秒数
TIMEOUT="${PI_STOP_TIMEOUT:-15}"

log() { printf '[stop] %s\n' "$*"; }

if [ ! -f "$PID_FILE" ]; then
  log "未找到 $PID_FILE，pi 可能未运行"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
case "$PID" in
  ''|*[!0-9]*)
    rm -f "$PID_FILE"
    log "pid 文件内容无效，已清理"
    exit 0
    ;;
esac

if ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE" "$FIFO_FILE"
  log "进程 $PID 不存在，已清理残留文件"
  exit 0
fi

# SIGTERM 触发 pi 有序退出，给正在进行的任务收尾时间
log "正在停止 pi (pid $PID)..."
kill -TERM "$PID" 2>/dev/null || true

i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
  i=$((i + 1))
done

if kill -0 "$PID" 2>/dev/null; then
  log "等待 ${TIMEOUT}s 仍未退出，强制结束"
  kill -KILL "$PID" 2>/dev/null || true
  sleep 1
fi

rm -f "$PID_FILE" "$FIFO_FILE"
log "已停止 pi (pid $PID)"
