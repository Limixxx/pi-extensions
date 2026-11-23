# PI 工作区（.pi）Agent 指南

本目录是 [pi](https://pi.dev) 工作区配置与扩展集合，本身是一个独立的 Git 仓库（`origin` 指向 `Limixxx/pi-extensions`），与所在项目解耦、可整体迁移；涉及本目录的改动以本文件为准。

## 目录职责

- `scripts/init.sh`：安装/更新 pi 与 `npm:pi-feishu` 扩展。
- `scripts/start.sh`：默认拉起 sidecar 守护进程（`extensions/sidecar/sidecar.mjs`），由它以 RPC 模式启动并守护 pi；`PI_SIDECAR_ENABLED=0` 时回退为直接后台启动 pi（旧版行为）。pid、日志与启动信息写入 `sessions/`。
- `scripts/stop.sh`：停止 sidecar（发 SIGTERM + 写停止标记文件，由 sidecar 负责停 pi 子进程、注销节点并清理文件）；直启模式下直接停 pi。
- `scripts/init.ps1` / `start.ps1` / `stop.ps1`：上面两个脚本的 Windows PowerShell 版本，行为一致。sidecar 托管时 `pi-rpc.pid` 记录的是 cmd 垫片进程的 pid，pi 本身的 pid 在 `pi-rpc.info` 的 `pi_pid=`；命令入口是命名管道 `\\.\pipe\pi-rpc-<hash>`（名字见 `pi-rpc.info` 的 `pipe=`，与旧版 keeper 兼容）。`PI_SIDECAR_ENABLED=0` 时回退为旧版 keeper 直启。
- `extensions/litellm-provider.ts`：向 pi 注册 `maas` provider，模型列表来自 `LITELLM_BASE_URL/models`，默认模型为 `LITELLM_DEFAULT_MODEL`（缺省 `GLM-5.3`）。未设置 `LITELLM_API_KEY` 时插件不启用（跳过注册，不抛错）。
- `extensions/kubectl.ts`：注册 `kubectl` 工具，按 `kubectl.tools` 白名单前缀匹配，未列出的子命令默认拒绝；`timeout` 参数默认 60s、上限 600s。另注册 `/kubectl` 斜杠命令（仅 TUI 模式）查看当前白名单。
- `extensions/kubectl.tools`：kubectl 子命令白名单，每行一条、`#` 注释，每次调用重新读取，改完立即生效。
- `extensions/gh_tools.ts`：注册 `gh_*` 系列工具（`gh_auth`、`gh_issue`、`gh_pr`、`gh_repo`、`gh_actions`、`gh_release`、`gh_api`、`gh_search`、`gh_secret`、`gh_variable`、`gh_label`、`gh_gist`、`gh_config`、`gh_key`、`gh_project`），封装本机 `gh` CLI。
- `extensions/webserver/index.ts` + `public/index.html`：进程管理 Web UI。RPC 模式下自动启动 HTTP 服务（默认 `127.0.0.1:3170`，可用 `PI_WEB_*` 环境变量调整），提供状态/日志/插件/会话查询与中止、压缩、停进程等操作；地址写入 `sessions/pi-web.info`，`start.sh` / `start.ps1` 会读取并打印；另注册 `/web` 斜杠命令显示管理界面地址。无外部依赖，仅用 node 内置模块。详细文档见 [extensions/webserver/README.md](extensions/webserver/README.md)。
- `extensions/sidecar/`：sidecar 守护进程与节点注册中心。`.mjs` 模块（`sidecar.mjs` 入口、`supervisor.mjs` 子进程守护、`registry.mjs` 注册中心、`client.mjs` 注册与心跳、`common.mjs` 配置与工具）构成独立 node 进程，由 start 脚本拉起；`index.ts` 是 pi 扩展，注册 `pi_registry` 工具（`action=list|get|self`，查注册中心节点）与 `/sidecar` 斜杠命令。master 模式本机运行 HTTP 注册中心（默认 `127.0.0.1:3180`），slave 模式向 `PI_SIDECAR_MASTER_URL` 注册；心跳超时标 offline、恢复自动 online、长期离线清理。无外部依赖，仅用 node 内置模块。
- `.env` / `.env.example`：凭证与网关配置模板。`.env` 已被忽略，禁止提交。
- `sessions/`：运行时目录，存放 `pi-sidecar.pid`、`pi-sidecar.info`、`pi-rpc.pid`、`pi-rpc.info`、`pi-rpc.log`、`pi-rpc.err.log`、`pi-web.info`、`registry.json`（master 注册表）、`self.json`（本节点留档）（Linux 另有 `pi-rpc.fifo`；Windows 用命名管道，不落盘）；只保留 `.keep` 入库。

## 常用操作

```bash
.pi/scripts/init.sh          # 安装 pi / pi-feishu，并更新扩展版本
.pi/scripts/start.sh         # 启动 sidecar，由其拉起并守护 pi --mode rpc
.pi/scripts/stop.sh          # 停止 sidecar 与 pi
pi list                      # 查看已安装扩展（含 pi-feishu）
```

Windows 使用同名 ps1：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1`。

启动后可向 `sessions/pi-rpc.fifo` 逐行写入 JSON 命令下发请求（sidecar 托管与直启模式一致），例如：

```bash
printf '%s\n' '{"id":"1","type":"get_state"}' > .pi/sessions/pi-rpc.fifo
```

stdout 是严格 JSONL 协议记录（写入 `pi-rpc.log`），stderr 是诊断日志（写入 `pi-rpc.err.log`），不要把两者混在一起解析。RPC 在 stdin 读到 EOF 时会走有序退出，因此 sidecar（或直启脚本）以读写方式打开 FIFO 作为 stdin 保持常驻。sidecar 自身的日志在 `sessions/pi-sidecar.log`。

**sidecar 托管模式（默认）**：pi 崩溃后由 sidecar 指数退避自动重启；stop 脚本发 SIGTERM（Linux）或写停止标记文件 `sessions/pi-sidecar.stop`（Windows 主机制，500ms 轮询）让 sidecar 优雅退出。节点信息查询用 `pi_registry` 工具或 `/sidecar` 命令，详见上文 `extensions/sidecar/` 条目与 `PI_SIDECAR_*` 环境变量。

**扩展中禁止使用 `console.log`**：RPC 模式下 stdout 是协议流，`console.log` 会直接污染 JSONL（历史上 `litellm-provider.ts` 的注册日志混入过 `pi-rpc.log`），所有扩展日志一律走 `console.error`。

## 环境变量

| 变量 | 用途 | 来源 |
| --- | --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书开放平台凭证（pi-feishu 用，环境变量优先于 settings.json） | `.env` |
| `LITELLM_BASE_URL` | MaaS/LiteLLM 网关地址，默认 `http://i-nhi.zhejianglab.org/maas/v1` | `.env` |
| `LITELLM_API_KEY` | 网关密钥，未设置时不启用 `maas` provider 插件 | `.env` |
| `LITELLM_DEFAULT_MODEL` | 新建会话默认模型，缺省 `GLM-5.3` | `.env` |
| `KUBECTL_TOOLS_FILE` | 覆盖 kubectl 白名单文件路径 | 可选 |
| `PI_WEB_ENABLED` | Web 管理界面开关：留空自动（仅 RPC 模式启动）、1 强制、0 禁用 | 可选 |
| `PI_WEB_HOST` / `PI_WEB_PORT` | Web 管理界面监听地址与端口，默认 `127.0.0.1:3170` | 可选 |
| `PI_WEB_TOKEN` | Web 管理界面访问令牌（Bearer），设置后 `/api` 接口需携带 | 可选 |
| `PI_WEB_LOG_STDOUT` / `PI_WEB_LOG_STDERR` | RPC 日志路径覆盖；不设置时按约定路径 `sessions/pi-rpc.log` / `pi-rpc.err.log` 定位 | 可选 |
| `PI_SIDECAR_ENABLED` | sidecar 守护开关，默认启用；设为 0 回退旧版直启 | 可选 |
| `PI_SIDECAR_MODE` | sidecar 模式 `master` / `slave`；不设则 auto（配了 `PI_SIDECAR_MASTER_URL` 为 slave，否则 master） | 可选 |
| `PI_SIDECAR_MASTER_URL` | slave 节点指向的 master 注册中心地址 | `.env`（slave 必填） |
| `PI_SIDECAR_REGISTRY_HOST` / `PI_SIDECAR_REGISTRY_PORT` | master 注册中心监听地址，默认 `127.0.0.1:3180` | 可选 |
| `PI_SIDECAR_TOKEN` | 注册/心跳/查询接口 Bearer Token，不设则免鉴权 | 可选 |
| `PI_SIDECAR_NODE_ID` | 节点 ID，默认 `<hostname>-<workdir 哈希前 6 位>` | 可选 |
| `PI_SIDECAR_HEARTBEAT_INTERVAL` / `PI_SIDECAR_HEARTBEAT_TIMEOUT` / `PI_SIDECAR_OFFLINE_RETENTION` | 心跳间隔/超时判定/离线清理秒数，默认 10 / 30 / 3600 | 可选 |
| `PI_SIDECAR_BACKOFF_CAP` | pi 崩溃重启退避封顶秒（从 1s 起指数退避），默认 30 | 可选 |
| `PI_STOP_TIMEOUT` | `stop.sh` / `stop.ps1` 等待优雅退出的秒数，超时后强制结束（SIGKILL / `taskkill /T /F`），默认 15 | 可选 |

`.env` 使用 shell `export` 语法，脚本通过 `set -a; . .env` 加载；手工启动时同样需要先 dot-source。

## 约定

- 不提交 `.env`、日志、pid、fifo 等运行时产物；新增运行时文件时同步补充 `.gitignore`。
- 后台启动 pi 时必须带 `--approve`，否则项目内扩展（`litellm-provider.ts` 等）在非交互环境下不会被信任加载。
- 修改 kubectl 白名单坚持默认拒绝：只加需要的最小子命令，优先只读命令。
- `gh_tools.ts` 与 `kubectl.ts` 依赖本机 `gh` / `kubectl` 可执行文件，缺失时工具返回错误而不是崩溃，改动时保持该行为。
- 扩展通过 `pi.registerTool` / `pi.registerCommand` / `pi.registerProvider` 注册，全部使用 `// @ts-ignore` 引入类型，仓库不维护构建流程，直接以 `.ts` 交付。
- 扩展日志只能用 `console.error`（见上文 stdout 纯净性要求）；扩展内部任何异常都要自行捕获并降级为日志，不允许把异常抛到 pi 主进程导致退出（历史事故：飞书 API 400 未捕获致进程崩溃）。
- sidecar `.mjs` 模块与 `index.ts` 同样禁止 `console.log`（sidecar 的 stdout 也会被重定向到 `sessions/pi-sidecar.out.log`，但 stderr 才是约定日志流）；只用 node 内置模块，不引入 npm 依赖；修改配置项时同步更新 `.env.example`、`README.md` 与本文件。
- sidecar 停止依赖双机制：Linux 信号 + 跨平台停止标记文件。新增停止路径时保持两种机制都生效，并确认 stop 脚本的等待/强杀兑底顺序不变。
- `webserver/` 修改后同步检查：`index.ts`（服务与接口）与 `public/index.html`（页面）行为一致、sh 与 ps1 启动脚本均能读到 `pi-web.info`、新增接口在 [extensions/webserver/README.md](extensions/webserver/README.md) 的接口清单中登记。
- 脚本面向 Linux/bash（devcontainer 内以 `ubuntu` 用户运行），保持 `#!/usr/bin/env bash` 与 `set -euo pipefail`。`.sh` 脚本已在仓库记录可执行位（100755），检出后可直接执行；ps1 由 `powershell -File` 调用，不依赖可执行位。旧检出如缺执行权限，用 `chmod +x scripts/*.sh` 补齐。
- PowerShell 脚本保存为 UTF-8 **带 BOM**（Windows PowerShell 5.1 按 ANSI 解析无 BOM 文件，中文会乱码）；变量名不区分大小写，`param([switch]$Keeper)` 与局部变量 `$keeper` 会冲突，改用 `$keeperProc` 这类名字。
