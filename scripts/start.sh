#!/usr/bin/env bash
# 后台启动 pi RPC 服务（默认经 sidecar 守护进程托管）
#
# PI_SIDECAR_ENABLED≠0（默认）：拉起 extensions/sidecar/sidecar.mjs 守护进程，
#   由它拉起并守护 pi --mode rpc（崩溃自动重启），并按 master/slave 模式
#   向注册中心登记本节点（Web UI 地址、RPC 入口等）。
# PI_SIDECAR_ENABLED=0：跳过 sidecar，直接后台启动 pi（旧行为，无守护）。
#
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
SIDECAR_ENTRY="$PI_DIR/extensions/sidecar/sidecar.mjs"
SIDECAR_PID_FILE="$SESS_DIR/pi-sidecar.pid"
SIDECAR_INFO_FILE="$SESS_DIR/pi-sidecar.info"
SIDECAR_STOP_FILE="$SESS_DIR/pi-sidecar.stop"
SIDECAR_LOG_FILE="$SESS_DIR/pi-sidecar.log"

log() { printf '[start] %s\n' "$*"; }
die() { printf '[start] 错误: %s\n' "$*" >&2; exit 1; }

mkdir -p "$SESS_DIR"

case "${PI_SIDECAR_ENABLED:-1}" in
  0|false|no|off) SIDECAR_ENABLED=0 ;;
  *) SIDECAR_ENABLED=1 ;;
esac

# 载入 .env（PI_SIDECAR_* / FEISHU_* / LITELLM_* 等供子进程使用）
if [ -f "$PI_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PI_DIR/.env"
  set +a
fi

command -v pi >/dev/null 2>&1 || die "未找到 pi，请先执行 $SCRIPT_DIR/init.sh"

# 清理上次运行残留的 Web 管理界面信息（正常退出时会由扩展自行清理）
rm -f "$WEB_INFO_FILE"

wait_web_info() {
  web_i=0
  while [ "$web_i" -lt 15 ]; do
    [ -f "$WEB_INFO_FILE" ] && break
    sleep 1
    web_i=$((web_i + 1))
  done
  if [ -f "$WEB_INFO_FILE" ] && grep -q '^url=' "$WEB_INFO_FILE" 2>/dev/null; then
    log "进程管理界面: $(sed -n 's/^url=//p' "$WEB_INFO_FILE" | head -n 1)"
  else
    log "进程管理界面: 未启动（可用 PI_WEB_ENABLED/PI_WEB_PORT 控制，见 .env.example）"
  fi
}

# ── sidecar 托管模式 ────────────────────────────────────────
if [ "$SIDECAR_ENABLED" = "1" ]; then
  if [ -f "$SIDECAR_PID_FILE" ]; then
    old_sc_pid="$(cat "$SIDECAR_PID_FILE" 2>/dev/null || true)"
    if [ -n "$old_sc_pid" ] && kill -0 "$old_sc_pid" 2>/dev/null; then
      log "sidecar 已在运行 (pid $old_sc_pid)，无需重复启动"
      exit 0
    fi
    rm -f "$SIDECAR_PID_FILE"
  fi
  # pi 已由旧版脚本直接启动时 sidecar 会自行拒绝接管，这里提前给出提示
  if [ -f "$PID_FILE" ]; then
    old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      die "pi 已在运行 (pid $old_pid，可能由旧版脚本直接启动)。请先执行 $SCRIPT_DIR/stop.sh 再切换到 sidecar 托管"
    fi
    rm -f "$PID_FILE"
  fi

  command -v node >/dev/null 2>&1 || die "未找到 node，sidecar 守护依赖 node（或设置 PI_SIDECAR_ENABLED=0 回退直启）"

  rm -f "$SIDECAR_STOP_FILE"
  log "启动 sidecar 守护进程（配置见 .env.example 的 PI_SIDECAR_* 说明）..."
  cd "$WORK_DIR"
  nohup node "$SIDECAR_ENTRY" >>"$SIDECAR_LOG_FILE" 2>&1 &
  SIDECAR_PID=$!

  # 启动失败时尽快暴露
  sleep 2
  if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
    log "sidecar 启动失败，最近的错误输出："
    [ -f "$SIDECAR_LOG_FILE" ] && tail -n 20 "$SIDECAR_LOG_FILE" >&2
    exit 1
  fi

  log "sidecar 已启动 (pid $SIDECAR_PID)，由其拉起并守护 pi RPC 子进程"
  if [ -f "$SIDECAR_INFO_FILE" ]; then
    sed -n 's/^mode=/运行模式: /p;s/^node_id=/节点 ID: /p;s/^registry_url=/注册中心: /p;s/^master_url=/master: /p' "$SIDECAR_INFO_FILE"
  fi
  log "sidecar 日志: $SIDECAR_LOG_FILE"
  log "节点查询: pi_registry 工具（list/get/self）或 /sidecar 命令"
  log "停止: $SCRIPT_DIR/stop.sh"

  # 等待 sidecar 拉起 pi 子进程并写出进程信息
  rpc_i=0
  while [ "$rpc_i" -lt 15 ]; do
    [ -f "$PID_FILE" ] && break
    sleep 1
    rpc_i=$((rpc_i + 1))
  done
  if [ -f "$PID_FILE" ]; then
    log "pi RPC 子进程: pid $(cat "$PID_FILE")，进程信息: $INFO_FILE"
  else
    log "警告: 15s 内未见 pi 子进程 pid 文件，请检查 $SIDECAR_LOG_FILE"
  fi

  wait_web_info
  exit 0
fi

# ── 直启模式（PI_SIDECAR_ENABLED=0，旧行为） ────────────────
if [ -f "$PID_FILE" ]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    log "pi 已在运行 (pid $old_pid)，无需重复启动"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# RPC 从 stdin 读 JSON 命令，stdin 读到 EOF 会触发退出；
# 以读写方式打开 FIFO 作为 stdin，保证没有外部写入时也能常驻。
rm -f "$FIFO_FILE"
mkfifo "$FIFO_FILE"

cd "$WORK_DIR"
nohup pi --mode rpc --approve --continue --session-dir "$SESS_DIR" 0<>"$FIFO_FILE" >>"$LOG_FILE" 2>>"$ERR_FILE" &
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

wait_web_info
