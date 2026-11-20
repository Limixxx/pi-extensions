#!/usr/bin/env bash
# 初始化 pi 运行环境：安装 pi、安装 pi-feishu 扩展、更新扩展版本。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
FEISHU_PKG="npm:pi-feishu"

log() { printf '[init] %s\n' "$*"; }
die() { printf '[init] 错误: %s\n' "$*" >&2; exit 1; }

# 1. pi
if command -v pi >/dev/null 2>&1; then
  log "已安装 pi: $(pi --version 2>/dev/null | tail -n 1)"
else
  log "未检测到 pi，使用官方脚本安装..."
  curl -fsSL https://pi.dev/install.sh | sh
  # 安装脚本只会修改交互 shell 的 PATH，这里补充常见安装目录
  export PATH="$HOME/.pi/bin:$HOME/.local/bin:$PATH"
  command -v pi >/dev/null 2>&1 || die "pi 安装完成但不在 PATH 中，请重新登录后重试"
  log "pi 安装完成: $(pi --version 2>/dev/null | tail -n 1)"
fi

# 2. npm:pi-feishu
has_feishu() {
  # 先查设置文件（快、无网络），再回落到 pi list
  grep -qs 'pi-feishu' \
    "$HOME/.pi/settings.json" \
    "$HOME/.pi/agent/settings.json" \
    "$PI_DIR/settings.json" 2>/dev/null && return 0
  local listed
  listed="$(pi list 2>/dev/null || true)"
  case "$listed" in
    *pi-feishu*) return 0 ;;
  esac
  return 1
}

if has_feishu; then
  log "已安装扩展 $FEISHU_PKG"
else
  log "未检测到 $FEISHU_PKG，开始安装..."
  pi install "$FEISHU_PKG"
fi

# 3. 更新扩展版本
log "更新扩展 $FEISHU_PKG ..."
pi update --extension "$FEISHU_PKG"

# 4. 运行目录
mkdir -p "$PI_DIR/sessions"
if [ ! -f "$PI_DIR/.env" ]; then
  log "提示: 未找到 $PI_DIR/.env，可复制 .env.example 后填写（start.sh 会自动加载）"
fi

log "初始化完成"
