// @ts-ignore
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore
import { Type } from "typebox";
// @ts-ignore
import * as fs from "node:fs";
// @ts-ignore
import * as path from "node:path";
// @ts-ignore
import { fileURLToPath } from "node:url";

/**
 * pi sidecar 扩展（配套 extensions/sidecar/sidecar.mjs 守护进程）
 *
 * - 注册 pi_registry 工具：查询注册中心节点列表 / 节点详情 / 本机 sidecar 状态，
 *   用于跨机器发现各 pi 实例的 Web UI 地址与 RPC 入口。
 * - 注册 /sidecar 斜杠命令：查看本机 sidecar 与注册中心摘要。
 *
 * 数据来源优先级：PI_SIDECAR_MASTER_URL（slave）或 pi-sidecar.info（master 本地）
 * 的 HTTP 接口 → 本地 sessions/registry.json / self.json 文件兜底。
 * sidecar 未运行时工具返回提示而不是报错。
 *
 * 约定：所有日志走 stderr（console.error），严禁 console.log（stdout 是 RPC 协议流）；
 * 任何异常自行捕获降级，不允许抛到 pi 主进程。
 */

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SESS_DIR = path.resolve(EXT_DIR, "..", "..", "sessions");
const REGISTRY_JSON = path.join(SESS_DIR, "registry.json");
const SELF_JSON = path.join(SESS_DIR, "self.json");
const SIDECAR_INFO = path.join(SESS_DIR, "pi-sidecar.info");
const SYSTEM_PROMPT_FILE = path.join(SESS_DIR, "system-message.txt");

const REQUEST_TIMEOUT_MS = 5000;

function envStr(name: string): string {
    return (process.env[name] || "").trim();
}

/** 解析 key=value 行式 info 文件 */
function readInfoFile(p: string): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        const text = fs.readFileSync(p, "utf8");
        for (const line of text.split(/\r?\n/)) {
            const i = line.indexOf("=");
            if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
    } catch {
        // 文件不存在
    }
    return out;
}

function readJsonSafe(p: string): any {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return null;
    }
}

/** 查询端点：slave 用 PI_SIDECAR_MASTER_URL；master 用本机注册中心 */
function queryUrl(): string {
    return (
        envStr("PI_SIDECAR_MASTER_URL").replace(/\/+$/, "") ||
        readInfoFile(SIDECAR_INFO).master_url ||
        readInfoFile(SIDECAR_INFO).registry_url ||
        ""
    );
}

async function fetchNodes(): Promise<any> {
    const url = queryUrl();
    if (!url) return null;
    const headers: Record<string, string> = {};
    const token = envStr("PI_SIDECAR_TOKEN");
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${url}/api/nodes`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    return { source: url, live: true, ...data };
}

/** HTTP 失败时读本地持久化文件兜底 */
async function loadNodes(): Promise<any> {
    const url = queryUrl();
    try {
        return await fetchNodes();
    } catch (e) {
        // master 本地兜底 registry.json；slave 本地兜底 self.json
        const reg = readJsonSafe(REGISTRY_JSON);
        if (reg?.nodes) {
            const now = Date.now();
            const nodes = Object.values(reg.nodes).map((r: any) => ({
                ...r,
                status: now - (r.last_heartbeat || 0) <= 30_000 ? "online" : "offline",
            }));
            return { source: `${REGISTRY_JSON}（离线快照）`, live: false, nodes, stale: true, error: String((e as any)?.message || e) };
        }
        const self = readJsonSafe(SELF_JSON);
        if (self?.record) {
            return { source: `${SELF_JSON}（本机快照）`, live: false, nodes: [self.record], stale: true, error: String((e as any)?.message || e) };
        }
        return null;
    }
}

function fmtAge(ms: number): string {
    if (!ms || ms < 0) return "-";
    if (ms < 60_000) return `${Math.round(ms / 1000)}s 前`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min 前`;
    return `${Math.round(ms / 3_600_000)}h 前`;
}

function renderNodes(data: any, now = Date.now()): string {
    const lines: string[] = [];
    if (data.stale) {
        lines.push(`注意：注册中心不可达（${data.error || "未知错误"}），以下为本地持久化快照，状态可能过期`);
    }
    lines.push(`数据来源: ${data.source}`);
    const nodes: any[] = data.nodes || [];
    const online = nodes.filter((n) => n.status === "online").length;
    lines.push(`节点 ${nodes.length} 个（在线 ${online}）：`);
    for (const n of nodes) {
        const pi = n.pi || {};
        lines.push("");
        lines.push(`- ${n.node_id} [${n.status}] ${n.mode || "-"} · 主机 ${n.hostname || "-"}${(n.addresses || []).length ? ` (${(n.addresses || []).join(", ")})` : ""}`);
        lines.push(`  pi: pid ${pi.pid ?? "-"} · 启动 ${pi.started_at || "-"}`);
        if (pi.web_url) lines.push(`  Web UI: ${pi.web_url}`);
        lines.push(`  RPC 入口: ${pi.rpc_kind === "pipe" ? "命名管道" : "FIFO"} ${pi.rpc_path || "-"}`);
        if (pi.session_file) lines.push(`  会话文件: ${pi.session_file}`);
        lines.push(`  心跳: ${fmtAge(now - (n.last_heartbeat || 0))} · 自动重启 ${n.sidecar?.restarts ?? 0} 次 · 注册于 ${n.registered_at ? fmtAge(now - n.registered_at) : "-"}`);
    }
    return lines.join("\n");
}

function isAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e?.code === "EPERM"; // 存在但无权限发信号
    }
}

function renderSelf(): string {
    const info = readInfoFile(SIDECAR_INFO);
    const self = readJsonSafe(SELF_JSON);
    const reg = self?.registration;
    const lines: string[] = [];
    if (!info.pid) {
        lines.push("sidecar 未运行（sessions/pi-sidecar.info 不存在）。");
        lines.push("说明：sidecar 由 scripts/start.sh / start.ps1 在 PI_SIDECAR_ENABLED≠0 时自动拉起。");
        return lines.join("\n");
    }
    if (!isAlive(Number(info.pid))) {
        lines.push(`sidecar 未运行（sessions/pi-sidecar.info 记录的 pid ${info.pid} 已不存在，为停止后残留）。`);
        lines.push("重新启动: scripts/start.sh");
        return lines.join("\n");
    }
    lines.push(`sidecar: pid ${info.pid} · 模式 ${info.mode} · 节点 ${info.node_id}`);
    lines.push(`注册中心: ${info.registry_url || "-"} · master: ${info.master_url || "-"}`);
    lines.push(`心跳: 间隔 ${info.heartbeat_interval_s || "-"}s · 超时 ${info.heartbeat_timeout_s || "-"}s`);
    if (reg) {
        lines.push(`注册状态: ${reg.ok ? "正常" : `异常（${reg.error || "-"}）`} · 更新于 ${fmtAge(Date.now() - (reg.at || 0))}`);
    } else {
        lines.push("注册状态: 尚无心跳记录（sessions/self.json 不存在）");
    }
    return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
    // ── 捕获当前系统提示（含 SYSTEM.md 内容），供 sidecar 注册时上报，非直接读源文件 ──
    pi.on("before_agent_start", async (_event: any, ctx: any) => {
        try {
            const prompt: string = ctx?.getSystemPrompt?.();
            if (typeof prompt === "string" && prompt.length) {
                fs.mkdirSync(SESS_DIR, { recursive: true });
                fs.writeFileSync(SYSTEM_PROMPT_FILE, prompt, "utf8");
            }
        } catch (e: any) {
            console.error(`[pi-sidecar] 捕获系统提示失败: ${e?.message || e}`);
        }
    });

    // ── pi_registry 工具：查询注册中心节点 ──────────────────
    pi.registerTool({
        name: "pi_registry",
        label: "pi Registry",
        description:
            "查询 pi sidecar 注册中心：list 列出所有已注册节点（含各节点 Web UI 地址、RPC 入口、pi pid、心跳状态），" +
            "get 查看指定节点详情，self 查看本机 sidecar 运行状态。用于跨机器发现 pi 实例。",
        parameters: Type.Object({
            action: Type.Optional(Type.String({
                description: "操作：list（默认，列出节点）| get（节点详情，需 node）| self（本机 sidecar 状态）",
                enum: ["list", "get", "self"],
                default: "list",
            })),
            node: Type.Optional(Type.String({ description: "get 时的节点 ID（node_id）" })),
        }),
        async execute(_id: any, params: any) {
            try {
                const action = params?.action || "list";
                let text = "";
                if (action === "self") {
                    text = renderSelf();
                } else {
                    const data = await loadNodes();
                    if (!data) {
                        text =
                            "sidecar 注册中心不可用：未配置 PI_SIDECAR_MASTER_URL，且本地无 registry.json / self.json。\n" +
                            "sidecar 由 scripts/start.sh 在 PI_SIDECAR_ENABLED≠0（默认）时自动拉起；" +
                            "slave 节点需在 .env 中设置 PI_SIDECAR_MASTER_URL 指向 master。";
                    } else if (action === "get") {
                        const target = String(params?.node || "").trim();
                        const node = (data.nodes || []).find((n: any) => n.node_id === target);
                        text = node
                            ? renderNodes({ ...data, nodes: [node] })
                            : `未找到节点 ${target || "(空)"}。当前节点：${(data.nodes || []).map((n: any) => n.node_id).join(", ") || "无"}`;
                    } else {
                        text = renderNodes(data);
                    }
                }
                return { content: [{ type: "text", text }], details: {} };
            } catch (e: any) {
                return { content: [{ type: "text", text: `查询失败: ${e?.message || String(e)}` }], details: {} };
            }
        },
    });

    // ── /sidecar 斜杠命令：查看本机 sidecar 与注册中心摘要 ──
    pi.registerCommand("sidecar", {
        description: "查看 sidecar 守护进程与注册中心状态（节点列表见 pi_registry 工具）",
        handler: async (_args: string, cmdCtx: any) => {
            try {
                const lines: string[] = [renderSelf()];
                const data = await loadNodes();
                if (data) {
                    const online = (data.nodes || []).filter((n: any) => n.status === "online").length;
                    lines.push(`注册中心节点: ${(data.nodes || []).length} 个（在线 ${online}）`);
                }
                await cmdCtx?.ui?.notify?.(lines.join("\n"), "info");
            } catch (e: any) {
                console.error(`[pi-sidecar] /sidecar 执行异常: ${e?.message || e}`);
                try {
                    await cmdCtx?.ui?.notify?.(`查询 sidecar 状态失败: ${e?.message || e}`, "error");
                } catch { /* 无 UI 环境忽略 */ }
            }
        },
    });
}
