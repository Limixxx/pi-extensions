# Agent 配置模板

本目录是一套 **pi agent 级配置模板**，用于给不同 agent（不同机器、节点或角色）做个性化。使用时把本目录内容复制到目标 agent 的 pi 配置根目录：

- 默认位置：`~/.pi/agent`（Windows 为 `%USERPROFILE%\.pi\agent`）
- 或用 `PI_CODING_AGENT_DIR` 指向自定义目录（见「同一台机器运行多个 agent」）

复制完成后，pi 会自动读取根目录下的 `settings.json`、`SYSTEM.md`、`AGENTS.md`、`models.json`、`mcp.json`、`extensions/`、`skills/`、`prompts/` 等文件。

## 目录内容

| 路径 | 用途 | 复制后位置 |
| --- | --- | --- |
| `settings.json` | pi 与扩展的全局配置；当前包含 `feishu` 凭证段，也可写 `defaultProvider` / `defaultModel` / `defaultTools` 等 | `<agent 根>/settings.json` |
| `role/*.md` | 角色系统提示词模板，按 agent 职责选择 | 复制为 `<agent 根>/SYSTEM.md` |
| `README.md` | 本说明，仅作文档 | 可保留也可删除 |

`role/` 目录本身不会被 pi 读取，只是模板库；真正生效的是根目录下的 `SYSTEM.md`。

## 复制步骤

Windows PowerShell（在仓库根目录执行）：

```powershell
$agentRoot = Join-Path $env:USERPROFILE '.pi\agent'
New-Item -ItemType Directory -Force -Path $agentRoot | Out-Null
Copy-Item -Recurse -Force '.pi\agent\*' $agentRoot
```

Linux / bash：

```bash
mkdir -p ~/.pi/agent
cp -a .pi/agent/. ~/.pi/agent/
```

### 选择角色

每个 agent 只应有一个 `SYSTEM.md`，从 `role/` 里挑一个复制过去：

```powershell
# 调度节点
Copy-Item -Force '.pi\agent\role\Orchestrator.md' (Join-Path $agentRoot 'SYSTEM.md')
```

```bash
cp .pi/agent/role/Orchestrator.md ~/.pi/agent/SYSTEM.md
```

- `SYSTEM.md` 会**整体替换** pi 的默认系统提示，适合定义完整角色。
- 只想追加约束、保留默认提示时，改用 `APPEND_SYSTEM.md`（把角色文件中「只追加」的部分放进去）。
- 角色是 agent 级、对所有项目生效；若只想对单个项目改角色，应放到项目 `<cwd>/.pi/SYSTEM.md`，它优先于 agent 目录的同名文件。

## 按 agent 个性化

### settings.json

复制后按该 agent 的实际情况修改，不要把模板原样带到生产：

```json
{
  "$schema": "https://pi.dev/schemas/settings.schema.json",
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "domain": "feishu"
  },
  "defaultProvider": "maas",
  "defaultModel": "DeepSeek-V4-Flash"
}
```

可配置项：

| 配置 | 字段 | 说明 |
| --- | --- | --- |
| 飞书应用 | `feishu.appId` / `feishu.appSecret` / `feishu.domain` | 每个 agent 可绑定不同的飞书应用；`domain` 为 `feishu`（国内）或 `lark`（海外） |
| 飞书加解密 | `feishu.encryptKey` / `feishu.verificationToken` | 事件订阅需要时填写 |
| 默认模型 | `defaultProvider` / `defaultModel` | 启动时选中的 provider 与模型 ID |
| 默认工具 | `defaultTools` | 支持 `+name` / `-name` 增减，空数组关闭内置工具 |

字段名同时接受 camelCase 与 snake_case（如 `appId` / `app_id`）。

### 配置优先级

`settings.json` 是让配置**不依赖环境变量**的固化层，但不是所有环境变量都能被它替代：

| 配置 | 优先级（高 → 低） |
| --- | --- |
| 飞书凭证（pi-feishu） | CLI 标志 → 环境变量 → 项目 `.pi/settings.json` → agent `settings.json` |
| 模型 / 工具等 pi 设置 | 项目 `.pi/settings.json` → agent `settings.json`；单次运行可用 `--model` / `--tools` 覆盖 |
| 系统提示 | 项目 `.pi/SYSTEM.md` → agent `SYSTEM.md`；`APPEND_SYSTEM.md` 为追加 |
| 进程级 `PI_*` 变量 | 只能来自启动进程的环境变量，`settings.json` 无法替代 |

即：环境变量缺失时 `settings.json` 才生效（飞书场景），而 `PI_CODING_AGENT_DIR`、`PI_OFFLINE` 这类进程级变量必须在启动前设置。

### 同一台机器运行多个 agent

不要把多个角色混在同一个 agent 目录里。给每个 agent 建独立目录并设置 `PI_CODING_AGENT_DIR`：

```powershell
$env:PI_CODING_AGENT_DIR = 'D:\agents\orchestrator'
pi
```

```bash
export PI_CODING_AGENT_DIR=/opt/agents/executor-1
pi
```

注意：

- 当前 pi-feishu 固定读取 `~/.pi/agent/settings.json` 与 `<cwd>/.pi/settings.json`，不跟随 `PI_CODING_AGENT_DIR`。改用自定义目录后，飞书凭证请用环境变量或保留全局 `settings.json`。
- 若目标机已有 `~/.pi/agent/settings.json`，复制时**合并字段**，不要直接覆盖，否则会丢失原有全局限定配置。
- 与 sidecar 配合时，节点身份用 `PI_SIDECAR_NODE_ID` 区分；角色由 `SYSTEM.md` 区分，两者互不替代。

## 安全

- `settings.json` 可能包含 `appSecret`，不要提交真实凭据；模板中的值保持占位符，生产环境优先用环境变量注入。
- 本仓库 `.pi/.gitignore` 只忽略根目录的 `/settings.json` 与 `/SYSTEM.md`，`.pi/agent/settings.json` 是被跟踪的。修改后提交前先确认没有写入真实密钥。
- 角色文件可能规定「禁止使用工具」这类硬约束，复制前确认与目标节点的实际能力一致。

## 验证

```powershell
pi --list-models        # 确认 defaultProvider/defaultModel 可用
pi                      # 启动后在会话内执行
```

会话内可检查：

- `/feishu config`：查看当前生效的飞书配置（App ID 会被掩码）。
- `/settings`：查看/修改常用设置。
- `/reload`：改完 settings、SYSTEM.md 或扩展后热加载；`defaultProvider` / `defaultModel` 只在启动时决定，需重启进程。
