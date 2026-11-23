# sidecar 守护进程与节点注册中心

`extensions/sidecar/` 由两部分组成：

- **独立 node 守护进程**（`.mjs` 模块）：由 `scripts/start.sh` / `start.ps1` 后台拉起，拉起并守护 `pi --mode rpc --approve` 子进程，并按 master/slave 模式维护节点注册中心。
- **pi 扩展**（`index.ts`）：注册 `pi_registry` 工具与 `/sidecar` 斜杠命令，在 pi 会话内查询注册中心。

无外部依赖，仅用 node 内置模块；所有日志走 stderr。

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `sidecar.mjs` | 入口：单实例锁、pid/info 文件、信号与停止标记处理、优雅退出编排 |
| `supervisor.mjs` | 子进程守护：Linux 经 FIFO r+ 提供 stdin；Windows 经 cmd 垫片持有 stdin + 命名管道转发；崩溃指数退避重启（1s 起翻倍，封顶 `PI_SIDECAR_BACKOFF_CAP`，存活 60s 重置） |
| `registry.mjs` | master 注册中心：HTTP 服务、token 鉴权、HTML 状态页、`registry.json` 持久化（500ms 去抖原子写）、心跳超时/离线清理扫描 |
| `client.mjs` | 注册与心跳：首次直接注册，心跳携带全量最新信息；404 自动重注册；失败退避；`self.json` 本地留档；停止时尽力注销 |
| `common.mjs` | 路径（从 `import.meta.url` 推导，不依赖 cwd）、环境变量解析、info 文件读写等共享工具 |
| `index.ts` | pi 扩展：`pi_registry` 工具（`action=list|get|self`）、`/sidecar` 命令 |

## 模式与拓扑

- 不设 `PI_SIDECAR_MASTER_URL` → **master**：本机运行 HTTP 注册中心（`PI_SIDECAR_REGISTRY_HOST:PORT`，默认 `127.0.0.1:3180`），并把自己注册进去；注册表持久化到 `sessions/registry.json`，重启恢复。
- 设置了 `PI_SIDECAR_MASTER_URL` → **slave**：向远端 master 注册，周期心跳。

节点记录结构（registry.json / self.json / API 返回）：

```json
{
  "node_id": "host-a1b2c3", "hostname": "host", "addresses": ["10.0.0.5"],
  "workdir": "/data/xx/project", "platform": "linux", "mode": "slave",
  "sidecar": { "pid": 123, "started_at": "…", "restarts": 2 },
  "pi": { "pid": 456, "started_at": "…", "command": "pi --mode rpc --approve",
          "rpc_kind": "fifo", "rpc_path": "…/pi-rpc.fifo",
          "web_url": "http://10.0.0.5:3170/", "web_port": 3170, "session_file": "…" },
  "registered_at": 0, "last_heartbeat": 0, "status": "online"
}
```

`sidecar` / `pi` 由各节点心跳刷新；`registered_at` / `last_heartbeat` / `status` 由 master 维护。

## HTTP API（master）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /healthz` | 健康检查（免鉴权） |
| `GET /` | HTML 状态页（5s 自动刷新，免鉴权） |
| `GET /api/nodes` | 全部节点列表（含状态计算） |
| `GET /api/nodes/:node_id` | 单节点详情 |
| `POST /api/register` | 注册/刷新节点（body 为节点记录） |
| `POST /api/heartbeat` | 心跳；未知节点返回 404（客户端据此重注册） |
| `POST /api/deregister` | 注销（body：`{node_id}`） |

设置 `PI_SIDECAR_TOKEN` 后，除 `/healthz` 与状态页外均需 `Authorization: Bearer <token>`（或 `?token=`）。

## 生命周期

- **启动**：`start.sh` 清理残留停止标记 → 后台拉起 sidecar（日志 `sessions/pi-sidecar.log`）→ sidecar 单实例检查（`pi-sidecar.pid`、`pi-rpc.pid` 有存活进程则拒绝启动）→ 写 pid/info → master 模式起注册中心 → 拉起 pi 子进程 → 注册/心跳。
- **停止**：`stop.sh` 发 SIGTERM（Linux）并写 `sessions/pi-sidecar.stop` 标记（Windows 主机制，sidecar 500ms 轮询）→ sidecar 依次：停子进程（等待 `PI_STOP_TIMEOUT` 后强杀）→ 注销 → 注册中心落盘关闭 → 清理 pid/info/fifo/标记 → 退出。stop 脚本等待超时后强杀兜底。
- **崩溃**：pi 子进程退出 → 指数退避重启，`sidecar.restarts` 计数，心跳自动更新 registry 中记录；sidecar 自身崩溃则由外部（systemd 等）或人工 `start.sh` 恢复。

## 配置

全部环境变量见根目录 `.env.example` 的 `PI_SIDECAR_*` 段与 `README.md` 环境变量表。
