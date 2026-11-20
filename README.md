# NanHuInfer · PI 工作区

NanHuInfer 使用的 [pi](https://pi.dev) 配置与扩展集合：自定义 provider、工具扩展、队列启动脚本。本目录是独立 Git 仓库（`origin` 为 `Limixxx/pi-extensions`）。

## 快速开始

```bash
cd NanHuInfer/.pi
chmod +x scripts/*.sh      # 仓库未记录可执行位，首次检出后执行
cp .env.example .env       # 填写飞书凭证与 MaaS 网关配置

scripts/init.sh            # 安装 pi、npm:pi-feishu，并更新扩展
scripts/start.sh           # 后台启动 pi --mode rpc
scripts/stop.sh            # 停止后台 pi
```

运行状态在 `sessions/`：`pi-rpc.pid`（进程号）、`pi-rpc.info`（启动信息）、`pi-rpc.fifo`（命令入口）、`pi-rpc.log`（stdout 协议记录）、`pi-rpc.err.log`（stderr 诊断）。这些文件已被忽略，不入库。

## 目录结构

```text
.pi/
├── scripts/           init.sh / start.sh / stop.sh
├── extensions/        litellm-provider.ts / kubectl.ts / kubectl.tools / gh_tools.ts
├── sessions/          运行时 pid、日志、FIFO（仅 .keep 入库）
├── .env / .env.example 凭证与网关配置（.env 不入库）
└── AGENT.md           面向 agent 的详细约定
```

- `extensions/litellm-provider.ts`：注册 `maas` provider，从 `LITELLM_BASE_URL/models` 拉取模型列表，新建会话默认选中 `LITELLM_DEFAULT_MODEL`（缺省 `GLM-5.3`）。
- `extensions/kubectl.ts` + `kubectl.tools`：注册 `kubectl` 工具，按白名单前缀匹配，未列出的子命令默认拒绝，白名单改完立即生效。
- `extensions/gh_tools.ts`：注册 `gh_*` 系列工具，封装本机 `gh` CLI。

## 环境变量

`.env` 使用 shell `export` 语法，`start.sh` 会以 `set -a` 自动加载；手工启动时先 dot-source。

| 变量 | 说明 |
| --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书开放平台凭证（pi-channels 使用） |
| `LITELLM_BASE_URL` | MaaS/LiteLLM 网关地址 |
| `LITELLM_API_KEY` | 网关密钥，缺失时 `maas` provider 注册失败 |
| `LITELLM_DEFAULT_MODEL` | 新建会话默认模型 |
| `KUBECTL_TOOLS_FILE` | 覆盖 kubectl 白名单路径（可选） |

## RPC 模式

`start.sh` 以 `pi --mode rpc --approve` 后台启动：`--approve` 让项目内扩展在非交互环境下被信任加载。RPC 通过 stdin 读 JSONL 命令、stdout 写 JSONL 记录，stdin 遇 EOF 会有序退出，因此脚本用 FIFO 以读写方式打开 stdin 保持常驻。下发命令：

```bash
printf '%s\n' '{"id":"1","type":"get_state"}' > .pi/sessions/pi-rpc.fifo
```

协议细节见 pi 自带文档 `docs/rpc.md` 与 `docs/rpc-commands.md`。

## 其他组件

### pi-app-server

```bash
pi install npm:pi-app-server
npx pi-server serve --port 3141 --provider maas --model GLM-5.3
npx pi-server serve --port 3141
PI_VERSION=$(cat /root/.pi/agent/install/current-version)
npx pi-server serve --port 3141 --pi-cli-path ~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-workspce/pi-coding-agent/dist/bundle/cli.js
```

### pi-channels

已集成到 pi 框架中，通过 `settings.json` 配置。

```bash
pi install npm:@amaster.ai/pi-channels
```

### pi-feishu

```bash
pi install npm:pi-feishu
```

支持流式输出。

## 约定

- 不提交 `.env`、日志、pid、fifo 等运行时产物。
- 修改扩展或脚本前先阅读 [AGENT.md](AGENT.md)；NanHuInfer 自身的协作规范见仓库根目录 [AGENT.md](../AGENT.md)。
