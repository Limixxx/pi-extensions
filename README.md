# PI 工作区

[pi](https://pi.dev) 工作区配置与扩展集合：自定义 provider、工具扩展、队列启动脚本。本目录是独立 Git 仓库（`origin` 为 `Limixxx/pi-extensions`），可放入任意项目的 `.pi` 目录使用。

## 快速开始

```bash
cd .pi
cp .env.example .env       # 填写飞书凭证与 MaaS 网关配置

scripts/init.sh            # 安装 pi、npm:pi-feishu，并更新扩展
scripts/start.sh           # 后台启动 pi --mode rpc
scripts/stop.sh            # 停止后台 pi
```

Windows（PowerShell）：

```powershell
cd .pi
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\init.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop.ps1
```

运行状态在 `sessions/`：`pi-rpc.pid`（Linux 为 pi 进程号；Windows 为 keeper 进程号，pi 进程号见 `pi-rpc.info` 的 `pi_pid=`）、`pi-rpc.info`（启动信息）、`pi-rpc.fifo`（Linux 命令入口）、`pi-rpc.log`（stdout 协议记录）、`pi-rpc.err.log`（stderr 诊断）、`pi-web.info`（Web 管理界面地址；Windows 命令入口为命名管道，不落盘）。这些文件已被忽略，不入库。

## 目录结构

```text
.pi/
├── scripts/           init / start / stop 的 sh 与 ps1 版本
├── extensions/        litellm-provider.ts / kubectl.ts / kubectl.tools / gh_tools.ts / webserver/
├── sessions/          运行时 pid、日志、FIFO（仅 .keep 入库）
├── .env / .env.example 凭证与网关配置（.env 不入库）
└── AGENT.md           面向 agent 的详细约定
```

- `extensions/litellm-provider.ts`：注册 `maas` provider，从 `LITELLM_BASE_URL/models` 拉取模型列表，新建会话默认选中 `LITELLM_DEFAULT_MODEL`（缺省 `GLM-5.3`）；未设置 `LITELLM_API_KEY` 时不启用该插件。
- `extensions/kubectl.ts` + `kubectl.tools`：注册 `kubectl` 工具，按白名单前缀匹配，未列出的子命令默认拒绝，白名单改完立即生效；另注册 `/kubectl` 斜杠命令（TUI 模式）查看当前白名单。
- `extensions/gh_tools.ts`：注册 `gh_*` 系列工具，封装本机 `gh` CLI。
- `extensions/webserver/`：进程管理 Web UI（`index.ts` + `public/index.html`），RPC 模式自动启动，详见下文与 [extensions/webserver/README.md](extensions/webserver/README.md)；另注册 `/web` 斜杠命令显示管理界面地址。

## 环境变量

`.env` 使用 shell `export` 语法，`start.sh` 会以 `set -a` 自动加载；手工启动时先 dot-source。

| 变量 | 说明 |
| --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书开放平台凭证（pi-feishu 使用，环境变量优先于 settings.json） |
| `LITELLM_BASE_URL` | MaaS/LiteLLM 网关地址 |
| `LITELLM_API_KEY` | 网关密钥，缺失时不启用 `maas` provider 插件 |
| `LITELLM_DEFAULT_MODEL` | 新建会话默认模型 |
| `KUBECTL_TOOLS_FILE` | 覆盖 kubectl 白名单路径（可选） |
| `PI_WEB_ENABLED` | Web 管理界面开关：留空自动（仅 RPC 模式启动）、1 强制、0 禁用（可选） |
| `PI_WEB_HOST` / `PI_WEB_PORT` | Web 管理界面监听地址与端口，默认 `127.0.0.1:3170`（可选） |
| `PI_WEB_TOKEN` | Web 管理界面访问令牌，设置后 `/api` 接口需携带 Bearer Token（可选） |
| `PI_WEB_LOG_STDOUT` / `PI_WEB_LOG_STDERR` | RPC 日志路径覆盖，默认按 `sessions/pi-rpc.log` / `pi-rpc.err.log` 约定路径定位（可选） |
| `PI_STOP_TIMEOUT` | `stop.sh` / `stop.ps1` 等待优雅退出的秒数，超时后强制结束，默认 15（可选） |

## RPC 模式

`start.sh` 以 `pi --mode rpc --approve` 后台启动：`--approve` 让项目内扩展在非交互环境下被信任加载。RPC 通过 stdin 读 JSONL 命令、stdout 写 JSONL 记录，stdin 遇 EOF 会有序退出，因此脚本用 FIFO 以读写方式打开 stdin 保持常驻。下发命令：

```bash
printf '%s\n' '{"id":"1","type":"get_state"}' > .pi/sessions/pi-rpc.fifo
```

协议细节见 pi 自带文档 `docs/rpc.md` 与 `docs/rpc-commands.md`。

Windows 没有 FIFO，`start.ps1` 改由 keeper 进程持有 pi 的 stdin，并用命名管道 `\\.\pipe\pi-rpc-<hash>` 接收命令；管道名记录在 `pi-rpc.info` 的 `pipe=` 字段中。客户端写法：

```powershell
$client = [System.IO.Pipes.NamedPipeClientStream]::new('.', '<pipe 名>', [System.IO.Pipes.PipeDirection]::Out)
$client.Connect(3000)
$writer = [System.IO.StreamWriter]::new($client)
$writer.WriteLine('{"id":"1","type":"get_state"}')
$writer.Flush()
$client.Dispose()
```

`stop.ps1` 先结束 keeper，使 pi 读到 stdin EOF 后有序退出，等待超时再用 `taskkill /T /F` 兜底。

## 进程管理 Web UI

`extensions/webserver/` 在 RPC 模式下自动启动一个 HTTP 服务（默认 `http://127.0.0.1:3170/`），用于在浏览器中管理当前 pi 进程：

- **概览**：进程/模型/会话状态、启动时长、内存、工具调用统计、最近活动事件（任务开始、工具调用、回复、压缩等）。
- **日志**：实时查看与下载 `pi-rpc.log`（stdout JSONL）与 `pi-rpc.err.log`（stderr），支持末尾行数选择、关键字过滤、5 秒自动刷新。
- **插件与工具**：查看并勾选修改活跃工具集（对模型声明的工具）、斜杠命令、provider 与模型列表、MCP 服务器、磁盘扩展目录与设置；保存立即生效。
- **会话**：当前会话信息与最近条目，列出最近 100 个历史会话。
- **操作**：中止当前任务、压缩会话上下文、停止 pi 进程（需双重确认）。

`start.sh` / `start.ps1` 启动完成后会读取 `sessions/pi-web.info` 并打印访问地址；pi 会话内也可用 `/web` 斜杠命令随时查看。安全说明：默认只监听 `127.0.0.1`，本机访问无需令牌；如需远程访问，设置 `PI_WEB_HOST=0.0.0.0` 并务必同时设置 `PI_WEB_TOKEN`。静态页面不鉴权，所有 `/api` 数据接口需携带令牌。扩展日志全部走 stderr，不会污染 RPC stdout 协议。

接口清单、`pi-web.info` 文件格式与实现细节见 [extensions/webserver/README.md](extensions/webserver/README.md)。


## pi-feishu 扩展

飞书接入由 `npm:pi-feishu` 提供，`scripts/init.sh` 负责安装与版本更新，支持流式输出：

```bash
pi install npm:pi-feishu
```

凭证读取顺序：环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 优先于 settings.json 中的配置。

## 约定

- 不提交 `.env`、日志、pid、fifo 等运行时产物。
- 修改扩展或脚本前先阅读 [AGENT.md](AGENT.md)。
