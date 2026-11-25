#!/usr/bin/env bash
# 初始化 pi 运行环境：安装 pi、安装必需扩展、更新扩展版本。
# 必需扩展列表与 ~/.pi/agent/settings.json 的 packages 保持一致（可通过 `pi list` 确认）。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# —— 必需扩展（与 `pi list` 输出、~/.pi/agent/settings.json 的 packages 字段保持同步）——
# 新增或删除包时，先更新本机 pi install 再同步修改这里，保证脚本与实际依赖一致。
REQUIRED_PACKAGES=(
  "npm:pi-dsml"
  "git:github.com/Limixxx/pi-feishu@main"
  "git:github.com/Limixxx/pi-subagents@main"
)

log() { printf '[init] %s\n' "$*"; }
die() { printf '[init] 错误: %s\n' "$*" >&2; exit 1; }

# 检查包是否已安装：用 `pi list` 按 source 精确匹配（pi list 会打印完整 source）
# 不走 settings.json 的原因：包写入 agent 级 settings，project 级 settings 不会有这些 key
has_package() {
  local source="$1"
  local listed
  listed="$(pi list 2>/dev/null || true)"
  case "$listed" in
    *"$source"*) return 0 ;;
  esac
  return 1
}

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

# 2. 逐个安装缺失的必需扩展
for pkg in "${REQUIRED_PACKAGES[@]}"; do
  if has_package "$pkg"; then
    log "已安装扩展 $pkg"
  else
    log "未检测到 $pkg，开始安装..."
    pi install "$pkg" || die "安装 $pkg 失败"
  fi
done

# 3. 更新所有必需扩展
for pkg in "${REQUIRED_PACKAGES[@]}"; do
  log "更新扩展 $pkg ..."
  pi update --extension "$pkg" || log "警告: 更新 $pkg 失败（非致命，可能是网络或版本已是最新）"
done

# 4. 运行目录
mkdir -p "$PI_DIR/sessions"
if [ ! -f "$PI_DIR/.env" ]; then
  log "提示: 未找到 $PI_DIR/.env，可复制 .env.example 后填写（start.sh 会自动加载）"
fi

log "初始化完成（pi + ${#REQUIRED_PACKAGES[@]} 个扩展）"
