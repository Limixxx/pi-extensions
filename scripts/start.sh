#!/usr/bin/env bash
# 后台启动 pi RPC 服务：pi --mode rpc
# pid、启动信息与日志写入 .pi/sessions/
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="$(cd -- "$PI_DIR/.." && pwd)"

SESS_DIR="$PI_DIR/sessions"
PID_FILE="$SESS_DIR/pi-rpc.pid"
INFO_FILE="$SESS_DIR/pi-rpc.info"
FIFO_FILE="$SESS_DIR/pi-rpc.fifo"
LOG_FILE="$SESS_DIR/pi-rpc.log"
ERR_FILE="$SESS_DIR/pi-rpc.err.log"
WEB_INFO_FILE="$SESS_DIR/pi-web.info"

log() { printf '[start] %s\n' "$*"; }
die() { printf '[start] 错误: %s\n' "$*" >&2; exit 1; }

mkdir -p "$SESS_DIR"

# 已在运行则直接返回
if [ -f "$PID_FILE" ]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    log "pi 已在运行 (pid $old_pid)，无需重复启动"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

command -v pi >/dev/null 2>&1 || die "未找到 pi，请先执行 $SCRIPT_DIR/init.sh"

# 载入 .env（FEISHU_* / LITELLM_* 供扩展使用）
if [ -f "$PI_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PI_DIR/.env"
  set +a
fi

# RPC 从 stdin 读 JSON 命令，stdin 读到 EOF 会触发退出；
# 以读写方式打开 FIFO 作为 stdin，保证没有外部写入时也能常驻。
rm -f "$FIFO_FILE"
mkfifo "$FIFO_FILE"
# 清理上次运行残留的 Web 管理界面信息（正常退出时会由扩展自行清理）
rm -f "$WEB_INFO_FILE"

cd "$WORK_DIR"
nohup pi --mode rpc --approve 0<>"$FIFO_FILE" >>"$LOG_FILE" 2>>"$ERR_FILE" &
PID=$!

printf '%s\n' "$PID" > "$PID_FILE"
{
  printf 'pid=%s\n' "$PID"
  printf 'started_at=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  printf 'workdir=%s\n' "$WORK_DIR"
  printf 'command=pi --mode rpc --approve 0<>%s\n' "$FIFO_FILE"
  printf 'stdout_log=%s\n' "$LOG_FILE"
  printf 'stderr_log=%s\n' "$ERR_FILE"
} > "$INFO_FILE"

# 启动失败时尽快暴露
sleep 2
if ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  log "启动失败，最近的错误输出："
  [ -f "$ERR_FILE" ] && tail -n 20 "$ERR_FILE" >&2
  exit 1
fi

log "pi RPC 已启动 (pid $PID)"
log "工作目录: $WORK_DIR"
log "命令管道: $FIFO_FILE"
log "输出日志: $LOG_FILE"
log "错误日志: $ERR_FILE"
log "进程信息: $INFO_FILE"
log "停止: $SCRIPT_DIR/stop.sh"

# 等待并显示进程管理 Web UI（由 extensions/webserver 在 RPC 模式自动启动）
web_i=0
while [ "$web_i" -lt 10 ]; do
  [ -f "$WEB_INFO_FILE" ] && break
  sleep 1
  web_i=$((web_i + 1))
done
if [ -f "$WEB_INFO_FILE" ] && grep -q '^url=' "$WEB_INFO_FILE" 2>/dev/null; then
  log "进程管理界面: $(sed -n 's/^url=//p' "$WEB_INFO_FILE" | head -n 1)"
else
  log "进程管理界面: 未启动（可用 PI_WEB_ENABLED/PI_WEB_PORT 控制，见 .env.example）"
fi
