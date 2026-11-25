# pi 进程管理 Web UI

`webserver/` 是一个 pi 扩展：在 RPC 模式下自动启动一个无外部依赖的 HTTP 服务（默认 `http://127.0.0.1:3170/`），用于在浏览器中查看与管控当前 pi 进程——运行状态、日志、活动事件、已注册的 provider/工具/命令/MCP 与会话信息，并支持中止任务、压缩上下文、调整活跃工具集、停止进程等操作。

整体使用说明见上级文档 `.pi/README.md` 的「进程管理 Web UI」一节；本文档面向该扩展的结构、接口与实现约定。

## 目录结构

```text
webserver/
├── index.ts           # 扩展后端：HTTP 服务、/api 接口、活动事件采集、pi-web.info 写入
└── public/
    └── index.html     # 前端单文件页面（内联 CSS/JS），由后端静态托管
```

- **零依赖**：后端仅用 Node 内置模块（`http`/`fs`/`path`/`os`/`url`）与 pi SDK；前端无构建、无第三方库。
- 前后端仅通过 `/api/*` JSON 接口交互，页面可独立替换；修改 `index.ts` 后需重启 pi 进程生效。

## 启用逻辑

扩展随 pi 启动加载，HTTP 服务在首个 `session_start` 事件时按以下规则决定是否启动：

| `PI_WEB_ENABLED` | 行为 |
| --- | --- |
| `1` / `true` / `yes` / `on` | 任何模式强制启动 |
| `0` / `false` / `no` / `off` | 任何模式禁用 |
| 未设置或其他值（自动，默认） | 仅 `ctx.mode === "rpc"` 时启动，其他模式提示后跳过 |

- 服务在进程内只启动一次；会话切换（resume/new）不重复启动，仅刷新 `pi-web.info` 中的会话字段。
- 端口被占用（`EADDRINUSE`）时输出警告并放弃启动，扩展本身不报错；可用 `PI_WEB_PORT` 换端口。
- `session_shutdown` 时**同步**关闭服务并删除 `pi-web.info`（退出路径不等待异步任务，因此不能用异步关闭）。

## 斜杠命令

扩展注册 `/web` 命令：显示当前管理界面地址；服务未启动时显示原因（当前不在 RPC 模式，或已设置 `PI_WEB_ENABLED=0`）。地址通过 `ui.notify` 通知，仅在带 UI 的模式（如 TUI）可见。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_WEB_ENABLED` | 空（自动） | 启用开关，取值见上表 |
| `PI_WEB_HOST` | `127.0.0.1` | 监听地址；设为 `0.0.0.0` 允许远程访问（务必同时配置令牌） |
| `PI_WEB_PORT` | `3170` | 监听端口；非法值告警并回退默认值 |
| `PI_WEB_TOKEN` | 空 | Bearer 访问令牌；留空不鉴权，仅建议本机回环使用 |
| `PI_WEB_LOG_STDOUT` / `PI_WEB_LOG_STDERR` | 空 | RPC 日志路径覆盖 |

注册中心相关变量复用 sidecar 的配置，无需额外设置：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_SIDECAR_MASTER_URL` | 空 | 设置后「注册中心」页签查询该地址（slave 场景） |
| `PI_SIDECAR_TOKEN` | 空 | 注册中心启用鉴权时的 Bearer 令牌 |
| `PI_SIDECAR_REGISTRY_HOST` / `PI_SIDECAR_REGISTRY_PORT` | `127.0.0.1:3180` | 均未配置时，作为本机注册中心的兜底查询地址 |

查询地址解析顺序：`PI_SIDECAR_MASTER_URL` → `sessions/pi-sidecar.info` 的 `master_url` / `registry_url` → `http://<REGISTRY_HOST>:<REGISTRY_PORT>`。

日志文件定位顺序（`resolveLogPaths`，stdout/stderr 各自独立取值）：

1. `PI_WEB_LOG_STDOUT` / `PI_WEB_LOG_STDERR` 覆盖值；
2. `<cwd>/.pi/sessions/pi-rpc.info` 中的 `log=` / `errLog=` 字段；
3. 约定路径 `<cwd>/.pi/sessions/pi-rpc.log` / `pi-rpc.err.log`。

注意：当前 `start.sh` / `start.ps1` 写入 `pi-rpc.info` 的是 `stdout_log=` / `stderr_log=` 字段，与第 2 步的键名不匹配，实际通常命中第 3 步约定路径——与启动脚本写入的路径一致，行为正确。调整任一侧字段名时，需同步另一侧与本说明。

## settings.json 覆盖

除环境变量外，Web UI 配置也可通过 `settings.json` 的 `web` 字段配置，**优先级高于环境变量**，仅让取值生效而不改写 `process.env`。读取位置：项目 `<cwd>/.pi/settings.json`（优先级更高）与用户 `~/.pi/agent/settings.json`。示例：

```json
{
  "web": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 3170,
    "token": "your-token",
    "logStdout": "/abs/path/pi-rpc.log",
    "logStderr": "/abs/path/pi-rpc.err.log"
  }
}
```

各字段取值规则与对应环境变量一致（`enabled` 支持布尔或 `1/0/true/false` 字符串，`port` 支持数字或数字字符串）；未配置的字段回退到环境变量，最后才用默认值。日志路径对应 `PI_WEB_LOG_STDOUT` / `PI_WEB_LOG_STDERR`。

## 功能页面

页面为单 Tab 应用，含五个页签：

| 页签 | 内容 |
| --- | --- |
| **概览** | 进程（pid/Node 版本/pi 版本/模式/内存 RSS）、会话（文件/名称/条目数）、Web 服务（地址/监听/日志大小）、sidecar 与注册中心摘要（运行状态/模式/节点 ID/注册状态）、统计（任务数/工具调用与出错次数/正在执行的工具）；操作按钮：刷新、中止当前任务、压缩会话上下文、停止 pi 进程（双重确认）；最近活动事件流 |
| **日志** | 查看 stdout（RPC JSONL）与 stderr 日志：末尾行数选择（100/300/1000/3000）、关键字过滤、5 秒自动刷新、下载完整日志 |
| **插件与工具** | 活跃工具集勾选（保存即改 `pi.setActiveTools`，仅当前会话生效）、斜杠命令清单、provider 与模型列表（含上下文窗口）、MCP 服务器配置、磁盘上项目/用户扩展目录清单、与扩展相关的 settings 白名单 |
| **注册中心** | sidecar 注册中心节点列表：节点 ID/主机与地址/模式/在线状态/pi pid/Web UI 链接/RPC 入口/心跳时间/自动重启次数；本机节点高亮标记；RPC 入口以链接形式展示，点击即「试问」——弹窗发送消息并显示回复，每次都会新建独立会话；注册中心不可达时展示本地持久化快照并标记过期 |
| **会话** | 当前会话信息、最近 50 条条目摘要（角色/类型/预览）、历史会话列表（按修改时间倒序，最多 100 个） |

前端轮询：状态每 5s、活动事件每 2.5s、日志（勾选后）每 5s、注册中心（勾选后）每 5s。

## 活动事件

后端维护内存环形缓冲（上限 500 条，进程重启清空），记录以下事件，供「概览-最近活动」增量拉取（`/api/activity?since=<seq>`）：

`session_start`、`web_start`、`agent_start`、`agent_end`、`tool_start`、`tool_end`（含耗时与错误摘要）、`message`（助手回复，截断 240 字符）、`compact`、`compact_failed`、`model_select`、`action`（页面触发的操作）。

## HTTP 接口

所有 `/api/*` 接口返回 JSON（`cache-control: no-store`）；设置了 `PI_WEB_TOKEN` 时需鉴权，否则返回 401。POST 请求体必须为合法 JSON 且不超过 1MB（超限返回 400）。

### GET

| 接口 | 说明 |
| --- | --- |
| `/api/health` | 存活检查：pid、运行秒数、是否启用令牌 |
| `/api/status` | 「概览」数据源：进程、会话、模型、内存、任务与工具统计、日志路径与大小 |
| `/api/activity?since=<seq>&limit=<n>` | 增量活动事件；`limit` 1–500，默认 200，返回 `lastSeq` |
| `/api/logs?name=stdout\|stderr&lines=<n>` | 日志末尾内容；`lines` 1–5000，默认 300，返回文件路径、大小与是否截断 |
| `/api/logs/download?name=stdout\|stderr` | 下载完整日志（text/plain 附件） |
| `/api/tools` | 工具清单（名称/描述/exposure/来源）与活跃工具集 |
| `/api/commands` | 斜杠命令清单 |
| `/api/plugins` | provider 与模型列表、MCP 服务器、settings 白名单、磁盘扩展目录 |
| `/api/session` | 当前会话信息与最近条目摘要 |
| `/api/sessions` | 历史会话列表（按修改时间倒序，最多 100 个） |
| `/api/registry` | sidecar 注册中心数据：查询地址、本机节点信息、节点列表（含状态/心跳/Web UI/RPC 入口）；优先实时请求注册中心，失败时回落 `sessions/registry.json`（master）或 `self.json`（slave）快照，返回 `live` / `stale` / `error` 标记 |

### POST（body 为 JSON）

| 接口 | 说明 |
| --- | --- |
| `/api/tools/active` | `{"names": string[]}` 设置活跃工具集，仅当前会话生效 |
| `/api/abort` | 请求中止当前任务 |
| `/api/compact` | 请求压缩当前会话上下文 |
| `/api/shutdown` | 停止 pi 进程；先返回响应，约 0.5 秒后退出 |
| `/api/rpc/ask` | `{"nodeId": string, "message": string, "timeoutSec"?: number}` 对指定节点发起一次独立询问：每次拉起全新的 pi RPC 进程（`--no-session`，不保存会话）并返回助手回复；`timeoutSec` 5–300，默认 120。仅支持本机节点（RPC 入口是命名管道/FIFO，跨主机不可达），并发仅允许 1 个 |

未知路由返回 404，非 GET/POST 方法返回 405。

## pi-web.info 文件

服务启动后向 `<cwd>/.pi/sessions/pi-web.info` 写入以下字段，`start.sh` / `start.ps1` 读取其中的 `url=` 打印访问地址：

```text
url=http://127.0.0.1:3170
host=127.0.0.1
port=3170
token_protected=false
pid=12345
session_file=<当前会话文件路径>
workdir=<启动时工作目录>
started_at=<ISO8601 时间>
```

会话切换时刷新 `session_file` 等字段；`session_shutdown` 时删除该文件。

## 安全模型

- 默认只监听 `127.0.0.1`，仅本机可访问；远程访问需 `PI_WEB_HOST=0.0.0.0`，并**务必**同时设置 `PI_WEB_TOKEN`。
- 静态页面不鉴权（不含任何数据）；所有 `/api` 数据接口在设置令牌后要求鉴权，方式二选一：请求头 `Authorization: Bearer <token>` 或查询参数 `?token=<token>`，前端将令牌存于 localStorage。
- 静态文件仅允许 `public/` 目录内的文件，路径解析后仍须位于该目录内（防路径穿越）。
- 令牌经 HTTP 明文传输，仅建议在可信内网使用。

## 实现约定与限制

- 零外部依赖：仅 Node 内置模块与 pi SDK；无构建步骤，`.ts` 直接交付。
- 扩展日志一律走 stderr（`console.error`），严禁 `console.log`——RPC 模式下 stdout 是 JSONL 协议流。
- 容量上限：活动事件环形缓冲 500 条、日志末尾读取 512KB（超出截断并标记 `truncated`）、请求体 1MB。
- 端口占用（`EADDRINUSE`）时告警并放弃启动，扩展不报错；`PI_WEB_PORT` 非法时回退默认值。
- HTTP 服务进程内只启动一次；`session_shutdown` 同步关闭服务并清理 `pi-web.info`（见「启用逻辑」）。
- 修改 `index.ts` 后需重启 pi 进程生效；`public/index.html` 刷新浏览器即可。

## 快速验证

```bash
# RPC 模式启动 pi 后
curl http://127.0.0.1:3170/api/health

# 设置了 PI_WEB_TOKEN 时
curl -H "Authorization: Bearer $PI_WEB_TOKEN" http://127.0.0.1:3170/api/status

# 增量拉取活动事件
curl 'http://127.0.0.1:3170/api/activity?since=0&limit=50'

# 注册中心节点（注册中心启用令牌时同样需要 Bearer）
curl -H "Authorization: Bearer $PI_WEB_TOKEN" http://127.0.0.1:3170/api/registry
```

浏览器访问 `sessions/pi-web.info` 中 `url=` 指向的地址即可打开管理页面。
