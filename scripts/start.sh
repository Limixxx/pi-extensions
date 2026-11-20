#!/usr/bin/env bash
# ================================================================
# NanHuInfer PI Server — 后台启动（Linux / macOS）
#
# 产物:
#   .pi/channel-sessions/pi-server.pid
#   .pi/channel-sessions/pi-server.log
#   .pi/channel-sessions/pi-server.stdout.log
#   .pi/channel-sessions/pi-server.stderr.log
# ================================================================
set -euo pipefail

# —— 路径锚点 ——
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PI_DIR/.." && pwd)"
ENV_FILE="$PI_DIR/.env"
AGENT_DIR="$PI_DIR/agent"
SESSION_DIR="$PI_DIR/channel-sessions"
PID_FILE="$SESSION_DIR/pi-server.pid"
LOG_STDOUT="$SESSION_DIR/pi-server.stdout.log"
LOG_STDERR="$SESSION_DIR/pi-server.stderr.log"
GLOBAL_AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

mkdir -p "$SESSION_DIR"

# —— 检查已有进程 ——
if [[ -f "$PID_FILE" ]]; then
    old_pid=$(cat "$PID_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
        echo "[start] pi-server 已在运行 (PID=$old_pid)"
        exit 0
    fi
    rm -f "$PID_FILE"
fi

# —— 初始化项目级 agent 目录（如果不存在）——
if [[ ! -d "$AGENT_DIR" ]]; then
    echo "[start] 初始化项目级 agent 目录: $AGENT_DIR"
    mkdir -p "$AGENT_DIR"

    # 复制配置文件
    for f in settings.json auth.json models.json models-store.json; do
        src="$GLOBAL_AGENT/$f"
        dst="$AGENT_DIR/$f"
        if [[ -f "$src" && ! -f "$dst" ]]; then
            cp "$src" "$dst"
        fi
    done

    # npm 插件（symlink 而不是复制）
    if [[ -d "$GLOBAL_AGENT/npm" && ! -e "$AGENT_DIR/npm" ]]; then
        ln -s "$GLOBAL_AGENT/npm" "$AGENT_DIR/npm"
        echo "[start]   symlink: npm -> $GLOBAL_AGENT/npm"
    fi

    # 写入项目级 settings.json（覆盖全局）
    if [[ -f "$PI_DIR/settings.json" ]]; then
        cp "$PI_DIR/settings.json" "$AGENT_DIR/settings.json"
    fi
fi

export PI_CODING_AGENT_DIR="$AGENT_DIR"
echo "[start] PI_CODING_AGENT_DIR = $AGENT_DIR"

# —— 加载 .env ——
if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
    echo "[start] 已加载 $ENV_FILE"
else
    echo "[start] 警告: $ENV_FILE 不存在，将使用当前环境" >&2
fi

# —— 清理旧 channel session ——
rm -f "$SESSION_DIR"/feishu-*.jsonl

# —— 定位 pi-server cli ——
PI_SERVER_CLI=""
for candidate in \
    "$(dirname "$(which pi-server 2>/dev/null)")/../lib/node_modules/@marcfargas/pi-server/dist/cli.js" \
    "$HOME/.npm/_npx/"*/"node_modules/@marcfargas/pi-server/dist/cli.js"; do
    if [[ -f "$candidate" ]]; then
        PI_SERVER_CLI="$candidate"
        break
    fi
done

cd "$REPO_ROOT"
echo "[start] CWD   = $REPO_ROOT"

if [[ -n "$PI_SERVER_CLI" ]]; then
    echo "[start] cli   = $PI_SERVER_CLI"
    nohup node "$PI_SERVER_CLI" serve --port 3141 \
        >"$LOG_STDOUT" 2>"$LOG_STDERR" &
else
    echo "[start] cli   = (通过 npx 解析)"
    nohup npx pi-server serve --port 3141 \
        >"$LOG_STDOUT" 2>"$LOG_STDERR" &
fi

PID=$!
echo "$PID" > "$PID_FILE"

sleep 2
if ! kill -0 "$PID" 2>/dev/null; then
    echo "[start] 错误: 进程启动后立即退出" >&2
    echo "--- stdout ---" >&2
    cat "$LOG_STDOUT" >&2
    echo "--- stderr ---" >&2
    cat "$LOG_STDERR" >&2
    rm -f "$PID_FILE"
    exit 1
fi

echo "[start] pi-server 已后台启动 (PID=$PID)"
echo "[start] PID   = $PID_FILE"
echo "[start] stdout = $LOG_STDOUT"
echo "[start] stderr = $LOG_STDERR"
echo
echo "查看日志: tail -f $LOG_STDOUT"
echo "停止服务: bash .pi/scripts/stop.sh"
