# PI 工作区（.pi）Agent 指南

本目录是 NanHuInfer 使用的 [pi](https://pi.dev) 工作区配置与扩展集合，本身是一个独立的 Git 仓库（`origin` 指向 `Limixxx/pi-extensions`）。仓库根目录的 [AGENT.md](../AGENT.md) 描述 NanHuInfer 本身的协作规范，两者并行生效：涉及本目录的改动以本文件为准。

## 目录职责

- `scripts/init.sh`：安装/更新 pi 与 `npm:pi-feishu` 扩展。
- `scripts/start.sh`：以 RPC 模式后台启动 pi，pid、日志与启动信息写入 `sessions/`。
- `scripts/stop.sh`：停止 `start.sh` 启动的 pi 进程。
- `scripts/init.ps1` / `start.ps1` / `stop.ps1`：上面三个脚本的 Windows PowerShell 版本，行为一致；`start.ps1` 用 keeper 进程持有 pi 的 stdin，命令入口是命名管道 `\\.\pipe\pi-rpc-<hash>`（名字见 `pi-rpc.info` 的 `pipe=`）。
- `extensions/litellm-provider.ts`：向 pi 注册 `maas` provider，模型列表来自 `LITELLM_BASE_URL/models`，默认模型为 `LITELLM_DEFAULT_MODEL`（缺省 `GLM-5.3`）。未设置 `LITELLM_API_KEY` 时扩展直接抛错。
- `extensions/kubectl.ts`：注册 `kubectl` 工具，按 `kubectl.tools` 白名单前缀匹配，未列出的子命令默认拒绝。
- `extensions/kubectl.tools`：kubectl 子命令白名单，每行一条、`#` 注释，每次调用重新读取，改完立即生效。
- `extensions/gh_tools.ts`：注册 `gh_*` 系列工具（`gh_auth`、`gh_issue`、`gh_pr`、`gh_repo`、`gh_actions`、`gh_release`、`gh_api`、`gh_search`、`gh_secret`、`gh_variable`、`gh_label`、`gh_gist`、`gh_config`、`gh_key`、`gh_project`），封装本机 `gh` CLI。
- `.env` / `.env.example`：凭证与网关配置模板。`.env` 已被忽略，禁止提交。
- `sessions/`：运行时目录，存放 `pi-rpc.pid`、`pi-rpc.info`、`pi-rpc.log`、`pi-rpc.err.log`（Linux 另有 `pi-rpc.fifo`；Windows 用命名管道，不落盘）；只保留 `.keep` 入库。

## 常用操作

```bash
.pi/scripts/init.sh          # 安装 pi / pi-feishu，并更新扩展版本
.pi/scripts/start.sh         # 后台启动 pi --mode rpc
.pi/scripts/stop.sh          # 停止后台 pi
pi list                      # 查看已安装扩展（含 pi-feishu）
```

Windows 使用同名 ps1：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1`。

启动后可向 `sessions/pi-rpc.fifo` 逐行写入 JSON 命令下发请求，例如：

```bash
printf '%s\n' '{"id":"1","type":"get_state"}' > .pi/sessions/pi-rpc.fifo
```

stdout 是严格 JSONL 协议记录（写入 `pi-rpc.log`），stderr 是诊断日志（写入 `pi-rpc.err.log`），不要把两者混在一起解析。RPC 在 stdin 读到 EOF 时会走有序退出，因此 `start.sh` 用 FIFO 以读写方式打开 stdin 保持常驻。

## 环境变量

| 变量 | 用途 | 来源 |
| --- | --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书开放平台凭证（pi-channels 用） | `.env` |
| `LITELLM_BASE_URL` | MaaS/LiteLLM 网关地址，默认 `http://i-nhi.zhejianglab.org/maas/v1` | `.env` |
| `LITELLM_API_KEY` | 网关密钥，未设置时 `maas` provider 注册失败 | `.env` |
| `LITELLM_DEFAULT_MODEL` | 新建会话默认模型，缺省 `GLM-5.3` | `.env` |
| `KUBECTL_TOOLS_FILE` | 覆盖 kubectl 白名单文件路径 | 可选 |

`.env` 使用 shell `export` 语法，脚本通过 `set -a; . .env` 加载；手工启动时同样需要先 dot-source。

## 约定

- 不提交 `.env`、日志、pid、fifo 等运行时产物；新增运行时文件时同步补充 `.gitignore`。
- 后台启动 pi 时必须带 `--approve`，否则项目内扩展（`litellm-provider.ts` 等）在非交互环境下不会被信任加载。
- 修改 kubectl 白名单坚持默认拒绝：只加需要的最小子命令，优先只读命令。
- `gh_tools.ts` 与 `kubectl.ts` 依赖本机 `gh` / `kubectl` 可执行文件，缺失时工具返回错误而不是崩溃，改动时保持该行为。
- 扩展通过 `pi.registerTool` / `pi.registerCommand` / `pi.registerProvider` 注册，全部使用 `// @ts-ignore` 引入类型，仓库不维护构建流程，直接以 `.ts` 交付。
- 脚本面向 Linux/bash（devcontainer 内以 `ubuntu` 用户运行），保持 `#!/usr/bin/env bash` 与 `set -euo pipefail`。仓库当前未记录可执行位，检出后用 `chmod +x scripts/*.sh` 或 `bash scripts/xxx.sh` 调用。
- PowerShell 脚本保存为 UTF-8 **带 BOM**（Windows PowerShell 5.1 按 ANSI 解析无 BOM 文件，中文会乱码）；变量名不区分大小写，`param([switch]$Keeper)` 与局部变量 `$keeper` 会冲突，改用 `$keeperProc` 这类名字。
