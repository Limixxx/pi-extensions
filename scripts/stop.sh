#!/usr/bin/env bash
# ================================================================
# NanHuInfer PI Server — 停止（Linux / macOS）
#
# 读取 .pi/channel-sessions/pi-server.pid → 优雅终止
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSION_DIR="$PI_DIR/channel-sessions"
PID_FILE="$SESSION_DIR/pi-server.pid"

if [[ ! -f "$PID_FILE" ]]; then
    echo "[stop] PID 文件不存在: $PID_FILE（可能没在运行）" >&2
    exit 0
fi

PID=$(cat "$PID_FILE")

if ! kill -0 "$PID" 2>/dev/null; then
    echo "[stop] PID=$PID 不存在，清理 PID 文件"
    rm -f "$PID_FILE"
    exit 0
fi

echo "[stop] 正在停止 pi-server (PID=$PID)..."
kill "$PID" 2>/dev/null || true

# 等待优雅退出（最多 3s）
for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    sleep 0.3
done

if kill -0 "$PID" 2>/dev/null; then
    echo "[stop] 进程仍存活，强制终止..."
    kill -9 "$PID" 2>/dev/null || true
fi

rm -f "$PID_FILE"
echo "[stop] pi-server 已停止"
