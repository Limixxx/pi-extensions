// @ts-ignore
import { SessionManager, VERSION, RpcClient, getPackageDir } from "@earendil-works/pi-coding-agent";
// @ts-ignore
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore
import * as http from "node:http";
// @ts-ignore
import * as fs from "node:fs";
// @ts-ignore
import * as fsp from "node:fs/promises";
// @ts-ignore
import * as path from "node:path";
// @ts-ignore
import * as os from "node:os";
// @ts-ignore
import { fileURLToPath } from "node:url";

/**
 * pi 进程管理 Web UI
 *
 * 在 RPC 模式下自动启动一个 HTTP 服务，用于查看当前 pi 进程的运行状态、
 * 日志、活动事件、已注册的 provider / 工具 / 命令 / MCP，以及当前会话信息，
 * 并支持中止任务、压缩上下文、调整活跃工具集、停止 pi 进程等操作。
 *
 * 日志约定：本扩展所有输出必须走 stderr（console.error），严禁 console.log。
 * RPC 模式下 stdout 是严格的 JSONL 协议流，console.log 会污染协议。
 */

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(EXT_DIR, "public");

// ===== settings.json 配置（可选，优先级高于环境变量） =====
// 读取项目 <cwd>/.pi/settings.json 与用户 ~/.pi/agent/settings.json 的 "web" 字段，
// 取其值覆盖环境变量参与配置解析。仅让值生效，不改写 process.env。
// settings.json 示例：
//   {
//     "web": {
//       "enabled": true,
//       "host": "0.0.0.0",
//       "port": 3170,
//       "token": "your-token",
//       "logStdout": "/abs/path/pi-rpc.log",
//       "logStderr": "/abs/path/pi-rpc.err.log"
//     }
//   }

function loadSettingsWeb(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const projectPath = path.join(process.cwd(), ".pi", "settings.json");
    const userPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
    // 用户级在前、项目级在后：后写入者覆盖前者（项目级优先级更高）
    const files: string[] = [];
    if (userPath !== projectPath) files.push(userPath);
    files.push(projectPath);
    for (const f of files) {
        try {
            if (!fs.existsSync(f)) continue;
            const data = JSON.parse(fs.readFileSync(f, "utf8"));
            const web = data?.web;
            if (web && typeof web === "object") Object.assign(out, web);
        } catch (e) {
            console.error(`[pi-web] 读取 settings.json 失败(${f}): ${errText(e)}`);
        }
    }
    return out;
}

const SETTINGS = loadSettingsWeb();

/** 单独加载 sidecar 字段（与 web 分离，避免 token 键冲突） */
function loadSettingsSidecar(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const projectPath = path.join(process.cwd(), ".pi", "settings.json");
    const userPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
    const files: string[] = [];
    if (userPath !== projectPath) files.push(userPath);
    files.push(projectPath);
    for (const f of files) {
        try {
            if (!fs.existsSync(f)) continue;
            const data = JSON.parse(fs.readFileSync(f, "utf8"));
            const sc = data && typeof data === "object" ? data.sidecar : undefined;
            if (sc && typeof sc === "object") Object.assign(out, sc);
        } catch (e) {
            console.error(`[pi-web] 读取 settings.json 失败(${f}): ${errText(e)}`);
        }
    }
    return out;
}

const SIDECAR_SETTINGS = loadSettingsSidecar();

function sidecarStr(key: string): string {
    const v = SIDECAR_SETTINGS[key];
    if (v === undefined || v === null) return "";
    return typeof v === "string" ? v : String(v);
}

function settingStr(key: string): string | undefined {
    const v = SETTINGS[key];
    if (v === undefined || v === null) return undefined;
    return typeof v === "string" ? v : String(v);
}

function settingBool(key: string): boolean | null {
    const v = SETTINGS[key];
    if (v === undefined || v === null) return null;
    // 兼容布尔值与 "1"/"true"/"0"/"false" 等字符串
    return typeof v === "boolean" ? v : parseEnabled(String(v));
}

function resolveEnabled(): boolean | null {
    const s = settingBool("enabled");
    if (s !== null) return s;
    return parseEnabled(process.env.PI_WEB_ENABLED);
}

function resolveHost(): string {
    const s = settingStr("host")?.trim();
    if (s) return s;
    return (process.env.PI_WEB_HOST || "127.0.0.1").trim();
}

function resolvePort(): number {
    const sv = SETTINGS["port"];
    if (sv !== undefined && sv !== null) {
        const n = Number(sv);
        if (Number.isInteger(n) && n > 0 && n < 65536) return n;
        console.error(`[pi-web] settings.json 中 web.port 值非法（"${String(sv)}"），回退环境变量/默认端口`);
    }
    return parsePort(process.env.PI_WEB_PORT, 3170);
}

function resolveToken(): string {
    const s = settingStr("token");
    if (s !== undefined) return s.trim();
    return (process.env.PI_WEB_TOKEN || "").trim();
}

function resolveLogOverride(key: string, envName: string): string {
    const s = settingStr(key);
    if (s !== undefined) return s.trim();
    return (process.env[envName] || "").trim();
}

const CONFIG = {
    /** null = 自动（仅 RPC 模式启用）；true / false = 强制 */
    enabled: resolveEnabled(),
    host: resolveHost(),
    port: resolvePort(),
    /** 访问令牌（Bearer Token），留空表示不鉴权 */
    token: resolveToken(),
    /** 日志路径覆盖：默认从 <cwd>/.pi/sessions/ 读取 pi-rpc.log / pi-rpc.err.log */
    stdoutLogOverride: resolveLogOverride("logStdout", "PI_WEB_LOG_STDOUT"),
    stderrLogOverride: resolveLogOverride("logStderr", "PI_WEB_LOG_STDERR"),
    /** sidecar 注册中心：slave 用 master 地址，master 缺省用本机监听地址 */
    sidecarMasterUrl: (sidecarStr("masterUrl") || (process.env.PI_SIDECAR_MASTER_URL || "").trim()).replace(/\/+$/, ""),
    sidecarToken: sidecarStr("token") || (process.env.PI_SIDECAR_TOKEN || "").trim(),
    sidecarRegistryHost: sidecarStr("registryHost") || (process.env.PI_SIDECAR_REGISTRY_HOST || "").trim() || "127.0.0.1",
    sidecarRegistryPort: (() => {
        const sv = SIDECAR_SETTINGS["registryPort"];
        if (sv !== undefined && sv !== null) {
            const n = Number(sv);
            if (Number.isInteger(n) && n > 0 && n < 65536) return n;
            console.error(`[pi-web] settings.json 中 sidecar.registryPort 值非法（"${String(sv)}"），回退环境变量/默认端口`);
        }
        return parsePort(process.env.PI_SIDECAR_REGISTRY_PORT, 3180, "PI_SIDECAR_REGISTRY_PORT");
    })(),
};

const MAX_ACTIVITY = 500;
const MAX_TAIL_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
};

interface ActivityEvent {
    seq: number;
    ts: number;
    kind: string;
    data: unknown;
}

// ===== 运行时状态（扩展存活期间常驻） =====

let server: http.Server | null = null;
let serverUrl = "";
let extApi: ExtensionAPI | null = null;
// @ts-ignore
let ctxRef: any = null;
const startedAtMs = Date.now();
const activity: ActivityEvent[] = [];
let nextSeq = 1;
const stats = { agentRuns: 0, toolCalls: 0, toolErrors: 0 };
let agentBusy = false;
let runningTool: { name: string; startedAtMs: number } | null = null;

// ===== 工具函数 =====

function parseEnabled(raw: string | undefined): boolean | null {
    if (raw === undefined) return null;
    const v = raw.trim().toLowerCase();
    if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
    if (v === "0" || v === "false" || v === "no" || v === "off") return false;
    return null;
}

function parsePort(raw: string | undefined, fallback: number, envName = "PI_WEB_PORT"): number {
    if (!raw) return fallback;
    const n = Number(raw.trim());
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    console.error(`[pi-web] ${envName} 值非法（"${raw}"），使用默认端口 ${fallback}`);
    return fallback;
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function safeGet<T>(fn: () => T): T | null {
    try {
        return fn();
    } catch {
        return null;
    }
}

function safeBool(fn: () => boolean | undefined): boolean | null {
    try {
        const v = fn();
        return typeof v === "boolean" ? v : null;
    } catch {
        return null;
    }
}

/** 截断预览：对象转 JSON，字符串原样，超长截断 */
function preview(value: unknown, maxLen: number): string | null {
    if (value === undefined || value === null) return null;
    let s: string;
    if (typeof value === "string") {
        s = value;
    } else {
        try {
            s = JSON.stringify(value) ?? String(value);
        } catch {
            s = String(value);
        }
    }
    s = s.replace(/\s+/g, " ").trim();
    return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

/** 从 message.content（TextContent/... 数组）提取纯文本 */
function extractText(message: any): string {
    const parts = Array.isArray(message?.content) ? message.content : [];
    const texts: string[] = [];
    for (const p of parts) {
        if (typeof p?.text === "string") texts.push(p.text);
    }
    return texts.join("\n");
}

/** sourceInfo 归一化为展示字符串，如 "builtin" 或 "project:webserver/index.ts" */
function sourceLabel(si: any): string {
    if (!si) return "unknown";
    const p = typeof si.path === "string" ? si.path : "";
    if (p.startsWith("builtin:")) return "builtin";
    const scope = typeof si.scope === "string" ? si.scope : "?";
    let base = p ? path.basename(p) : (si.source ?? "?");
    // 目录型扩展带上目录名，便于区分（如 webserver/index.ts）
    const parts = p.split(path.sep);
    const i = parts.lastIndexOf("extensions");
    if (i >= 0 && i + 2 < parts.length) base = parts[i + 1] + "/" + parts[parts.length - 1];
    return `${scope}:${base}`;
}

function modelBrief(m: any) {
    if (!m) return null;
    const provider = typeof m.provider === "string" ? m.provider : (m.provider?.id ?? null);
    return { provider, id: m.id ?? null, name: m.name ?? m.id ?? null };
}

// ===== 活动事件环形缓冲 =====

function record(kind: string, data: unknown): void {
    activity.push({ seq: nextSeq++, ts: Date.now(), kind, data });
    if (activity.length > MAX_ACTIVITY) activity.splice(0, activity.length - MAX_ACTIVITY);
}

// ===== 路径解析 =====

function sessionDir(): string {
    const cwd = ctxRef?.cwd || process.cwd();
    return path.join(cwd, ".pi", "sessions");
}

/** RPC 日志路径：优先 PI_WEB_LOG_* 覆盖，其次 sessions/pi-rpc.info 的 log/errLog 字段，最后按约定 */
function resolveLogPaths(): { stdout: string; stderr: string } {
    const dir = sessionDir();
    const fallback = {
        stdout: CONFIG.stdoutLogOverride || path.join(dir, "pi-rpc.log"),
        stderr: CONFIG.stderrLogOverride || path.join(dir, "pi-rpc.err.log"),
    };
    if (CONFIG.stdoutLogOverride && CONFIG.stderrLogOverride) return fallback;
    try {
        const infoFile = path.join(dir, "pi-rpc.info");
        if (fs.existsSync(infoFile)) {
            const info = fs.readFileSync(infoFile, "utf8");
            const get = (key: string): string | null => {
                const m = info.match(new RegExp(`^${key}=(.*)$`, "m"));
                return m ? m[1].trim() : null;
            };
            const out = get("log");
            const err = get("errLog");
            if (out && err) {
                return {
                    stdout: CONFIG.stdoutLogOverride || out,
                    stderr: CONFIG.stderrLogOverride || err,
                };
            }
        }
    } catch {
        // 读取失败回退到约定路径
    }
    return fallback;
}

function logStat(file: string) {
    const st = safeGet(() => fs.statSync(file));
    return {
        path: file,
        exists: !!st,
        size: st?.size ?? 0,
        mtimeMs: st?.mtimeMs ?? null,
    };
}

// ===== sidecar 注册中心 =====

const REGISTRY_TIMEOUT_MS = 3000;
const REGISTRY_FALLBACK_HB_TIMEOUT_MS = 30_000;

/** 解析 key=value 行式 info 文件（缺失返回 {}） */
function readInfoFields(file: string): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        const text = fs.readFileSync(file, "utf8");
        for (const line of text.split(/\r?\n/)) {
            const i = line.indexOf("=");
            if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
    } catch {
        // 文件不存在
    }
    return out;
}

function readJsonFile(file: string): any {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function sidecarInfo(): Record<string, string> {
    return readInfoFields(path.join(sessionDir(), "pi-sidecar.info"));
}

function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e?.code === "EPERM"; // 无权限时按存活处理
    }
}

/** 注册中心查询地址：PI_SIDECAR_MASTER_URL → pi-sidecar.info 的 master/registry → 本机默认端口 */
function registryBaseUrl(): string {
    if (CONFIG.sidecarMasterUrl) return CONFIG.sidecarMasterUrl;
    const info = sidecarInfo();
    const fromInfo = (info.master_url || info.registry_url || "").replace(/\/+$/, "");
    if (fromInfo) return fromInfo;
    return `http://${CONFIG.sidecarRegistryHost}:${CONFIG.sidecarRegistryPort}`;
}

async function fetchRegistryNodes(url: string): Promise<any> {
    const headers: Record<string, string> = {};
    if (CONFIG.sidecarToken) headers.authorization = `Bearer ${CONFIG.sidecarToken}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REGISTRY_TIMEOUT_MS);
    try {
        const res = await fetch(`${url}/api/nodes`, { headers, signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

/** 注册中心节点记录归一化为前端展示结构 */
function normalizeNode(rec: any, now: number, selfId: string) {
    const pi = rec?.pi ?? {};
    const sc = rec?.sidecar ?? {};
    const hb = Number(rec?.last_heartbeat) || 0;
    const registeredAt = Number(rec?.registered_at) || 0;
    return {
        nodeId: String(rec?.node_id ?? "?"),
        hostname: rec?.hostname ?? null,
        addresses: Array.isArray(rec?.addresses) ? rec.addresses : [],
        workdir: rec?.workdir ?? null,
        platform: rec?.platform ?? null,
        mode: rec?.mode ?? null,
        status: rec?.status === "online" ? "online" : "offline",
        self: !!selfId && rec?.node_id === selfId,
        registeredAt: registeredAt || null,
        lastHeartbeat: hb || null,
        heartbeatAgeSec: hb ? Math.max(0, Math.round((now - hb) / 1000)) : null,
        pi: {
            pid: Number(pi.pid) || 0,
            startedAt: pi.started_at ?? null,
            webUrl: pi.web_url || null,
            rpcKind: pi.rpc_kind ?? null,
            rpcPath: pi.rpc_path ?? null,
            sessionFile: pi.session_file ?? null,
        },
        sidecar: {
            pid: Number(sc.pid) || 0,
            restarts: Number(sc.restarts) || 0,
            startedAt: sc.started_at ?? null,
        },
    };
}

function countNodes(nodes: any[]) {
    return {
        total: nodes.length,
        online: nodes.filter((n) => n.status === "online").length,
    };
}

/** 注册中心数据：优先实时 HTTP，失败时回落本地 registry.json（master）/ self.json（slave）快照 */
async function registryPayload() {
    const info = sidecarInfo();
    const selfId = info.node_id || "";
    const url = registryBaseUrl();
    const base = {
        ok: true,
        queryUrl: url,
        registryUrl: info.registry_url || null,
        masterUrl: info.master_url || null,
        mode: info.mode || null,
        nodeId: selfId || null,
        heartbeatIntervalSec: Number(info.heartbeat_interval_s) || null,
        heartbeatTimeoutSec: Number(info.heartbeat_timeout_s) || null,
    };
    try {
        const data = await fetchRegistryNodes(url);
        const now = Number(data?.now) || Date.now();
        const nodes = (Array.isArray(data?.nodes) ? data.nodes : []).map((r: any) =>
            normalizeNode(r, now, selfId),
        );
        return {
            ...base,
            live: true,
            stale: false,
            source: url,
            heartbeatTimeoutSec:
                Number(data?.heartbeat_timeout_ms) > 0
                    ? Math.round(Number(data.heartbeat_timeout_ms) / 1000)
                    : base.heartbeatTimeoutSec,
            ...countNodes(nodes),
            nodes,
        };
    } catch (e) {
        const err = errText(e);
        const now = Date.now();
        const reg = readJsonFile(path.join(sessionDir(), "registry.json"));
        if (reg?.nodes && typeof reg.nodes === "object") {
            const hbTimeout = REGISTRY_FALLBACK_HB_TIMEOUT_MS;
            const nodes = Object.values(reg.nodes).map((r: any) =>
                normalizeNode(
                    {
                        ...r,
                        status: now - (Number(r?.last_heartbeat) || 0) <= hbTimeout ? "online" : "offline",
                    },
                    now,
                    selfId,
                ),
            );
            return {
                ...base,
                live: false,
                stale: true,
                source: "sessions/registry.json（离线快照）",
                error: err,
                ...countNodes(nodes),
                nodes,
            };
        }
        const self = readJsonFile(path.join(sessionDir(), "self.json"));
        if (self?.record) {
            const nodes = [normalizeNode({ ...self.record, status: "online" }, now, selfId)];
            return {
                ...base,
                live: false,
                stale: true,
                source: "sessions/self.json（本机快照）",
                error: err,
                ...countNodes(nodes),
                nodes,
            };
        }
        return {
            ...base,
            ok: false,
            live: false,
            stale: true,
            source: null,
            error: `注册中心不可达: ${err}`,
            total: 0,
            online: 0,
            nodes: [],
        };
    }
}

/** 「概览」用的 sidecar 摘要：只读本地 info / self.json，不做网络请求 */
function sidecarStatusPayload() {
    const info = sidecarInfo();
    const pid = Number(info.pid) || 0;
    const self = readJsonFile(path.join(sessionDir(), "self.json"));
    const reg = self?.registration;
    return {
        running: pid > 0 && pidAlive(pid),
        pid: pid || null,
        mode: info.mode || null,
        nodeId: info.node_id || null,
        registryUrl: info.registry_url || null,
        masterUrl: info.master_url || null,
        heartbeatIntervalSec: Number(info.heartbeat_interval_s) || null,
        heartbeatTimeoutSec: Number(info.heartbeat_timeout_s) || null,
        queryUrl: registryBaseUrl(),
        registration: reg
            ? {
                  ok: !!reg.ok,
                  state: reg.state ?? null,
                  error: reg.error || null,
                  at: Number(reg.at) || null,
              }
            : null,
    };
}

// ===== RPC 试问（新建独立会话，不干扰当前会话） =====

const RPC_ASK_DEFAULT_TIMEOUT_SEC = 120;
const RPC_ASK_MAX_TIMEOUT_SEC = 300;
const RPC_ASK_MAX_MESSAGE = 8000;
const RPC_ASK_STDERR_MAX = 2000;
let rpcAskInFlight = false;

type AskResult = { code: number; payload: Record<string, unknown> };

function truncateText(s: string, max: number): string {
    return s.length > max ? `…（前 ${max} 字）\n` + s.slice(-max) : s;
}

/**
 * 向指定节点发起一次独立询问：
 * - 每次拉起一个全新的 pi RPC 进程（`--no-session`），不复用当前会话
 * - 仅限本机节点：RPC 入口是命名管道 / FIFO，跨主机不可达
 */
async function rpcAsk(body: any): Promise<AskResult> {
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const nodeId = typeof body?.nodeId === "string" ? body.nodeId.trim() : "";
    const timeoutSec = Math.min(
        Math.max(Number(body?.timeoutSec) || RPC_ASK_DEFAULT_TIMEOUT_SEC, 5),
        RPC_ASK_MAX_TIMEOUT_SEC,
    );
    if (!message) return { code: 400, payload: { ok: false, error: "message 不能为空" } };
    if (message.length > RPC_ASK_MAX_MESSAGE) {
        return { code: 400, payload: { ok: false, error: `message 过长（上限 ${RPC_ASK_MAX_MESSAGE} 字符）` } };
    }
    if (rpcAskInFlight) {
        return { code: 429, payload: { ok: false, error: "已有一次试问正在执行，请等待完成" } };
    }

    const registry = await registryPayload();
    const nodes: any[] = registry.nodes || [];
    const node = nodeId ? nodes.find((n) => n.nodeId === nodeId) : nodes.find((n) => n.self);
    if (!node) {
        return { code: 404, payload: { ok: false, error: `未找到节点: ${nodeId || "(空)"}` } };
    }

    const workdir = typeof node.workdir === "string" ? node.workdir : "";
    const sameHost = node.self || node.hostname === os.hostname();
    const dirOk = !!workdir && !!safeGet(() => fs.statSync(workdir).isDirectory());
    if (!sameHost) {
        return {
            code: 409,
            payload: {
                ok: false,
                error: `节点 ${node.nodeId} 不在本机：RPC 入口（命名管道/FIFO）仅本机可达，请在对应主机的管理界面操作`,
            },
        };
    }
    if (!dirOk) {
        return { code: 409, payload: { ok: false, error: `节点工作目录不可用: ${workdir || "(空)"}` } };
    }

    rpcAskInFlight = true;
    const startedMs = Date.now();
    let client: any = null;
    try {
        client = new RpcClient({
            cliPath: path.join(getPackageDir(), "dist", "cli.js"),
            cwd: workdir,
            args: ["--approve", "--no-session"],
            // 新进程只用于回答：关闭 Web UI，避免再次占用管理端口
            env: { PI_WEB_ENABLED: "0" },
        });
        await client.start();
        await client.promptAndWait(message, undefined, timeoutSec * 1000);
        const reply = await client.getLastAssistantText();
        let state: any = null;
        try {
            state = await client.getState();
        } catch {
            // 状态查询失败不影响回复
        }
        record("action", { action: "rpc_ask", nodeId: node.nodeId, ms: Date.now() - startedMs });
        return {
            code: 200,
            payload: {
                ok: true,
                nodeId: node.nodeId,
                rpcPath: node.pi?.rpcPath ?? null,
                reply: reply ?? "",
                sessionId: state?.sessionId ?? null,
                durationMs: Date.now() - startedMs,
            },
        };
    } catch (e) {
        const stderr = safeGet(() => String(client?.getStderr?.() ?? "").trim()) || "";
        return {
            code: 502,
            payload: {
                ok: false,
                nodeId: node.nodeId,
                error: errText(e),
                stderr: stderr ? truncateText(stderr, RPC_ASK_STDERR_MAX) : null,
                durationMs: Date.now() - startedMs,
            },
        };
    } finally {
        try {
            await client?.stop();
        } catch {
            // 停止失败忽略：进程已被回收或超时
        }
        rpcAskInFlight = false;
    }
}

/** 读取文件末尾：限制读取字节数与行数，返回是否发生截断 */
async function readTail(
    file: string,
    maxLines: number,
): Promise<{ lines: string[]; truncated: boolean }> {
    const stat = await fsp.stat(file);
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const fh = await fsp.open(file, "r");
    try {
        const length = stat.size - start;
        const buf = Buffer.alloc(Math.max(0, length));
        if (length > 0) await fh.read(buf, 0, length, start);
        let text = buf.toString("utf8");
        let truncated = start > 0;
        if (truncated) {
            const nl = text.indexOf("\n");
            text = nl >= 0 ? text.slice(nl + 1) : "";
        }
        let lines = text.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        if (lines.length > maxLines) {
            lines = lines.slice(-maxLines);
            truncated = true;
        }
        return { lines, truncated };
    } finally {
        await fh.close();
    }
}

// ===== Web 服务 =====

function wantServer(ctx: any): boolean {
    if (CONFIG.enabled !== null) return CONFIG.enabled;
    return ctx?.mode === "rpc";
}

function webInfoPath(): string {
    return path.join(sessionDir(), "pi-web.info");
}

function writeWebInfo(): void {
    try {
        const lines = [
            `url=${serverUrl}`,
            `host=${CONFIG.host}`,
            `port=${CONFIG.port}`,
            `token_protected=${CONFIG.token ? "true" : "false"}`,
            `pid=${process.pid}`,
            `session_file=${safeGet(() => ctxRef?.sessionManager?.getSessionFile?.()) ?? ""}`,
            `workdir=${ctxRef?.cwd ?? process.cwd()}`,
            `started_at=${new Date().toISOString()}`,
        ];
        fs.mkdirSync(sessionDir(), { recursive: true });
        fs.writeFileSync(webInfoPath(), lines.join("\n") + "\n", "utf8");
    } catch (e) {
        console.error(`[pi-web] 写入 pi-web.info 失败: ${errText(e)}`);
    }
}

function removeWebInfo(): void {
    try {
        fs.rmSync(webInfoPath(), { force: true });
    } catch {
        // 忽略清理失败
    }
}

function startServer(ctx: any): Promise<void> {
    return new Promise((resolve) => {
        if (server) {
            resolve();
            return;
        }
        const srv = http.createServer((req, res) => {
            handleRequest(req, res).catch((e) => {
                console.error(`[pi-web] 处理请求异常: ${errText(e)}`);
                try {
                    if (!res.headersSent) {
                        sendJson(res, 500, { ok: false, error: errText(e) });
                    } else {
                        res.end();
                    }
                } catch {
                    // 连接已断开
                }
            });
        });
        srv.on("error", (e: NodeJS.ErrnoException) => {
            if (e.code === "EADDRINUSE") {
                console.error(
                    `[pi-web] 端口 ${CONFIG.port} 已被占用，Web 管理界面未启动；可用 PI_WEB_PORT 换一个端口`,
                );
            } else {
                console.error(`[pi-web] HTTP 服务异常: ${errText(e)}`);
            }
            server = null;
            resolve();
        });
        srv.listen(CONFIG.port, CONFIG.host, () => {
            server = srv;
            const displayHost = CONFIG.host === "0.0.0.0" ? "127.0.0.1" : CONFIG.host;
            serverUrl = `http://${displayHost}:${CONFIG.port}/`;
            writeWebInfo();
            record("web_start", {
                url: serverUrl,
                host: CONFIG.host,
                port: CONFIG.port,
                tokenProtected: !!CONFIG.token,
            });
            console.error(
                `[pi-web] 进程管理界面已启动: ${serverUrl}` +
                    (CONFIG.token ? "（已启用令牌鉴权）" : "（未启用鉴权，默认仅监听本机回环地址）"),
            );
            resolve();
        });
    });
}

function stopServerSync(): void {
    const srv = server;
    server = null;
    if (!srv) return;
    try {
        srv.closeAllConnections?.();
    } catch {
        // Node 版本差异
    }
    try {
        srv.close();
    } catch {
        // 重复关闭
    }
    console.error("[pi-web] 进程管理界面已停止");
    removeWebInfo();
}

// ===== HTTP 处理 =====

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    res.end(text);
}

function isAuthorized(req: http.IncomingMessage, u: URL): boolean {
    if (!CONFIG.token) return true;
    const header = req.headers["authorization"];
    if (header === `Bearer ${CONFIG.token}`) return true;
    return u.searchParams.get("token") === CONFIG.token;
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("请求体过大（上限 1MB）"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

/** 静态文件：仅允许 public/ 目录内的文件，路径需解析后仍在目录内 */
function serveStatic(res: http.ServerResponse, pathname: string): boolean {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(PUBLIC_DIR, rel);
    if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, "index.html")) {
        return false;
    }
    const st = safeGet(() => fs.statSync(target));
    if (!st || !st.isFile()) return false;
    const ext = path.extname(target).toLowerCase();
    const mime = MIME[ext as keyof typeof MIME] || "application/octet-stream";
    const res2 = res.writeHead(200, {
        "content-type": mime,
        "content-length": String(st.size),
        "cache-control": "no-store",
    });
    fs.createReadStream(target)
        .on("error", () => {
            try {
                res.end();
            } catch {
                // 连接已断开
            }
        })
        .pipe(res2);
    return true;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method || "GET").toUpperCase();
    const u = new URL(req.url || "/", "http://localhost");
    const pathname = decodeURIComponent(u.pathname);

    if (method === "GET" && !pathname.startsWith("/api/")) {
        // 静态页面不鉴权（不含数据）；数据接口全部鉴权
        if (serveStatic(res, pathname)) return;
        sendJson(res, 404, { ok: false, error: "未找到资源" });
        return;
    }

    if (!isAuthorized(req, u)) {
        sendJson(res, 401, { ok: false, error: "unauthorized：请携带正确的访问令牌" });
        return;
    }

    const route = pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
    const q = (k: string) => u.searchParams.get(k) ?? undefined;

    if (method === "GET") {
        switch (route) {
            case "health": {
                sendJson(res, 200, {
                    ok: true,
                    pid: process.pid,
                    uptimeSec: Math.floor(process.uptime()),
                    tokenProtected: !!CONFIG.token,
                });
                return;
            }
            case "status": {
                sendJson(res, 200, statusPayload());
                return;
            }
            case "activity": {
                const since = Number(q("since") ?? 0) || 0;
                const limit = Math.min(Math.max(Number(q("limit") ?? 200) || 200, 1), 500);
                const events = activity.filter((e) => e.seq > since).slice(-limit);
                sendJson(res, 200, {
                    ok: true,
                    events,
                    lastSeq: activity.length > 0 ? activity[activity.length - 1].seq : 0,
                });
                return;
            }
            case "logs": {
                const name = q("name") === "stderr" ? "stderr" : "stdout";
                const lines = Math.min(Math.max(Number(q("lines") ?? 300) || 300, 1), 5000);
                const file = resolveLogPaths()[name];
                try {
                    const tail = await readTail(file, lines);
                    sendJson(res, 200, {
                        ok: true,
                        name,
                        file,
                        ...logStat(file),
                        truncated: tail.truncated,
                        lines: tail.lines,
                    });
                } catch (e) {
                    sendJson(res, 200, {
                        ok: false,
                        error: `读取日志失败: ${errText(e)}`,
                        name,
                        file,
                        ...logStat(file),
                        truncated: false,
                        lines: [],
                    });
                }
                return;
            }
            case "logs/download": {
                const name = q("name") === "stderr" ? "stderr" : "stdout";
                const file = resolveLogPaths()[name];
                const st = safeGet(() => fs.statSync(file));
                if (!st || !st.isFile()) {
                    sendJson(res, 404, { ok: false, error: `日志文件不存在: ${file}` });
                    return;
                }
                res.writeHead(200, {
                    "content-type": "text/plain; charset=utf-8",
                    "content-length": String(st.size),
                    "content-disposition": `attachment; filename="pi-rpc${name === "stderr" ? ".err" : ""}.log"`,
                });
                fs.createReadStream(file)
                    .on("error", (e) => {
                        console.error(`[pi-web] 下载日志失败: ${errText(e)}`);
                        try {
                            res.end();
                        } catch {
                            // 连接已断开
                        }
                    })
                    .pipe(res);
                return;
            }
            case "tools": {
                sendJson(res, 200, toolsPayload());
                return;
            }
            case "commands": {
                sendJson(res, 200, commandsPayload());
                return;
            }
            case "plugins": {
                sendJson(res, 200, pluginsPayload());
                return;
            }
            case "session": {
                sendJson(res, 200, sessionPayload());
                return;
            }
            case "sessions": {
                sendJson(res, 200, await sessionsPayload());
                return;
            }
            case "registry": {
                sendJson(res, 200, await registryPayload());
                return;
            }
        }
        sendJson(res, 404, { ok: false, error: `未知接口: GET /api/${route}` });
        return;
    }

    if (method === "POST") {
        let body: any = null;
        try {
            const raw = await readBody(req);
            body = raw ? JSON.parse(raw) : {};
        } catch (e) {
            sendJson(res, 400, { ok: false, error: `请求体必须是合法 JSON: ${errText(e)}` });
            return;
        }
        switch (route) {
            case "tools/active": {
                const names = Array.isArray(body?.names)
                    ? body.names.filter((n: unknown) => typeof n === "string")
                    : null;
                if (!names) {
                    sendJson(res, 400, { ok: false, error: 'body 需为 {"names": string[]}' });
                    return;
                }
                try {
                    extApi?.setActiveTools(names);
                } catch (e) {
                    sendJson(res, 500, { ok: false, error: `设置活跃工具失败: ${errText(e)}` });
                    return;
                }
                record("action", { action: "set_active_tools", count: names.length });
                sendJson(res, 200, {
                    ok: true,
                    active: safeGet(() => extApi?.getActiveTools()) ?? names,
                });
                return;
            }
            case "abort": {
                try {
                    ctxRef?.abort?.();
                    record("action", { action: "abort" });
                    sendJson(res, 200, { ok: true, message: "已请求中止当前任务" });
                } catch (e) {
                    sendJson(res, 500, { ok: false, error: errText(e) });
                }
                return;
            }
            case "compact": {
                try {
                    ctxRef?.compact?.();
                    record("action", { action: "compact" });
                    sendJson(res, 200, { ok: true, message: "已请求压缩当前会话上下文" });
                } catch (e) {
                    sendJson(res, 500, { ok: false, error: errText(e) });
                }
                return;
            }
            case "shutdown": {
                record("action", { action: "shutdown" });
                sendJson(res, 200, { ok: true, message: "pi 进程将在约 0.5 秒后退出" });
                // 先响应再退出，保证客户端能收到结果
                setTimeout(() => {
                    try {
                        ctxRef?.shutdown?.();
                    } catch {
                        // 退出失败时保留进程，由 stop.sh 兜底
                    }
                }, 500);
                return;
            }
            case "rpc/ask": {
                const result = await rpcAsk(body);
                sendJson(res, result.code, result.payload);
                return;
            }
        }
        sendJson(res, 404, { ok: false, error: `未知接口: POST /api/${route}` });
        return;
    }

    sendJson(res, 405, { ok: false, error: `不支持的请求方法: ${method}` });
}

// ===== 数据组装 =====

function statusPayload() {
    const ctx = ctxRef;
    const sm = ctx?.sessionManager;
    const logs = resolveLogPaths();
    const activeTools = safeGet(() => extApi?.getActiveTools?.()) ?? null;
    return {
        ok: true,
        pid: process.pid,
        nodeVersion: process.version,
        piVersion: safeGet(() => VERSION) ?? null,
        mode: ctx?.mode ?? null,
        hasUI: ctx?.hasUI ?? null,
        cwd: ctx?.cwd ?? process.cwd(),
        startedAtMs,
        uptimeSec: Math.floor(process.uptime()),
        rss: process.memoryUsage().rss,
        model: modelBrief(ctx?.model),
        idle: safeBool(() => ctx?.isIdle?.()),
        pendingMessages: safeBool(() => ctx?.hasPendingMessages?.()),
        agentBusy,
        runningTool,
        stats: {
            ...stats,
            activity: activity.length,
        },
        activeTools: activeTools ? activeTools.length : null,
        session: {
            file: safeGet(() => sm?.getSessionFile?.()) ?? null,
            name: safeGet(() => sm?.getSessionName?.()) ?? null,
            id: safeGet(() => sm?.getSessionId?.()) ?? null,
            dir: safeGet(() => sm?.getSessionDir?.()) ?? null,
            entries: safeGet(() => sm?.getEntries?.().length) ?? 0,
        },
        webserver: {
            url: serverUrl || null,
            host: CONFIG.host,
            port: CONFIG.port,
            tokenProtected: !!CONFIG.token,
        },
        sidecar: sidecarStatusPayload(),
        logs: {
            stdout: logStat(logs.stdout),
            stderr: logStat(logs.stderr),
        },
    };
}

function toolsPayload() {
    const all = safeGet(() => extApi?.getAllTools?.()) ?? null;
    const active = safeGet(() => extApi?.getActiveTools?.()) ?? [];
    if (!all) {
        return { ok: false, error: "无法获取工具列表（pi.getAllTools 不可用）", tools: [], active };
    }
    const activeSet = new Set(active);
    const tools = (all as any[])
        .map((t) => ({
            name: t?.name ?? "?",
            description: t?.description ?? "",
            exposure: t?.exposure ?? null,
            source: sourceLabel(t?.sourceInfo),
            active: activeSet.has(t?.name),
        }))
        .sort((a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1));
    return { ok: true, tools, active };
}

function commandsPayload() {
    const cmds = safeGet(() => extApi?.getCommands?.()) ?? null;
    if (!cmds) {
        return { ok: false, error: "无法获取命令列表（pi.getCommands 不可用）", commands: [] };
    }
    return {
        ok: true,
        commands: (cmds as any[]).map((c) => ({
            name: c?.name ?? "?",
            description: c?.description ?? "",
            source: sourceLabel(c?.sourceInfo),
        })),
    };
}

/** settings 白名单：只透出与扩展/插件相关的键，避免泄露其他配置 */
const SETTINGS_KEYS = [
    "extensions",
    "packages",
    "defaultTools",
    "defaultModel",
    "defaultProvider",
];

function settingsPayload(): Record<string, unknown> | null {
    const s = safeGet(() => extApi?.getSettings?.() as any);
    if (!s || typeof s !== "object") return null;
    const out: Record<string, unknown> = {};
    for (const k of SETTINGS_KEYS) {
        if (k in s) out[k] = s[k];
    }
    return out;
}

function providersPayload() {
    const models = safeGet(() => ctxRef?.modelRegistry?.getAvailable?.()) ?? [];
    const byProvider = new Map<string, any[]>();
    for (const m of models as any[]) {
        const pid = typeof m?.provider === "string" ? m.provider : (m?.provider?.id ?? "unknown");
        if (!byProvider.has(pid)) byProvider.set(pid, []);
        byProvider.get(pid)!.push({
            id: m?.id ?? "?",
            name: m?.name ?? m?.id ?? "?",
            contextWindow: m?.contextWindow ?? null,
            reasoning: !!m?.reasoning,
        });
    }
    return [...byProvider.entries()].map(([id, ms]) => ({
        id,
        count: ms.length,
        models: ms,
    }));
}

function mcpPayload() {
    const servers = safeGet(() => (extApi as any)?.getMcpServers?.()) ?? [];
    return (servers as any[]).map((s) => ({
        name: s?.name ?? "?",
        extensionPath: s?.extensionPath ?? null,
        config: s?.config ?? null,
    }));
}

/** 磁盘上的扩展目录清单（项目 + 用户） */
function diskPayload() {
    const cwd = ctxRef?.cwd ?? process.cwd();
    const dirs: Array<{ scope: string; dir: string }> = [
        { scope: "project", dir: path.join(cwd, ".pi", "extensions") },
        { scope: "user", dir: path.join(os.homedir(), ".pi", "agent", "extensions") },
    ];
    return dirs.map(({ scope, dir }) => {
        const entries = safeGet(() => fs.readdirSync(dir, { withFileTypes: true })) ?? null;
        if (!entries) return { scope, dir, exists: false, entries: [] };
        const list = (entries as fs.Dirent[])
            .filter((d) => d.name !== "node_modules" && !d.name.startsWith("."))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((d) => {
                if (d.isDirectory()) {
                    const hasIndex = safeGet(() =>
                        fs.statSync(path.join(dir, d.name, "index.ts")).isFile(),
                    );
                    return { name: d.name, kind: "dir", kindDetail: hasIndex ? "index.ts" : "目录（无 index.ts）" };
                }
                return {
                    name: d.name,
                    kind: "file",
                    kindDetail: d.name.endsWith(".ts") ? ".ts 扩展" : "数据/配置文件",
                };
            });
        return { scope, dir, exists: true, entries: list };
    });
}

function pluginsPayload() {
    return {
        ok: true,
        providers: providersPayload(),
        mcpServers: mcpPayload(),
        settings: settingsPayload(),
        disk: diskPayload(),
    };
}

/** 会话条目摘要：只提取展示所需的少量字段 */
function summarizeEntry(e: any, idx: number) {
    const msg = e?.message;
    let role: string | null = msg?.role ?? null;
    let text = msg ? extractText(msg) : "";
    const call = msg?.toolCall ?? e?.toolCall;
    if (!text && call) {
        role = "tool_call";
        text = `${call.name ?? "?"} ${preview(call.arguments ?? call.args, 140) ?? ""}`;
    }
    if (!text && typeof e?.type === "string") {
        text = e.type;
    }
    const type = typeof e?.type === "string" ? e.type : "unknown";
    return {
        idx,
        ts: e?.ts ?? null,
        type,
        role,
        preview: preview(text, 160),
    };
}

function sessionPayload() {
    const sm = ctxRef?.sessionManager;
    const entries = safeGet(() => sm?.getEntries?.()) ?? [];
    const recent = (entries as any[]).slice(-50).map((e, i, arr) => summarizeEntry(e, arr.length - i));
    return {
        ok: true,
        file: safeGet(() => sm?.getSessionFile?.()) ?? null,
        name: safeGet(() => sm?.getSessionName?.()) ?? null,
        id: safeGet(() => sm?.getSessionId?.()) ?? null,
        dir: safeGet(() => sm?.getSessionDir?.()) ?? null,
        count: entries.length,
        recent,
    };
}

async function sessionsPayload() {
    const cwd = ctxRef?.cwd ?? process.cwd();
    try {
        const list = (await SessionManager.list(cwd)) as any[];
        const sessions = list
            .map((s) => ({
                file: s?.path ?? "",
                name: s?.name ?? null,
                id: s?.id ?? null,
                cwd: s?.cwd ?? "",
                created: s?.created instanceof Date ? s.created.getTime() : null,
                modified: s?.modified instanceof Date ? s.modified.getTime() : null,
                messageCount: s?.messageCount ?? null,
            }))
            .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))
            .slice(0, 100);
        return { ok: true, sessions };
    } catch (e) {
        return { ok: false, error: `列出会话失败: ${errText(e)}`, sessions: [] };
    }
}

// ===== 扩展入口 =====

export default async function (pi: ExtensionAPI): Promise<void> {
    extApi = pi;

    pi.on("session_start", (event: any, ctx: any) => {
        try {
            ctxRef = ctx;
            record("session_start", { reason: event?.reason ?? null });
            if (!server) {
                if (!wantServer(ctx)) {
                    if (CONFIG.enabled === false) {
                        console.error("[pi-web] PI_WEB_ENABLED=0，进程管理界面已禁用");
                    } else if (ctx?.mode && ctx.mode !== "rpc") {
                        console.error(`[pi-web] 当前模式为 ${ctx.mode}，进程管理界面不启动（仅 RPC 模式自动启用）`);
                    }
                    return;
                }
                void startServer(ctx);
            } else {
                // 切换会话（resume/new）后刷新 info 文件中的会话信息
                writeWebInfo();
            }
        } catch (e) {
            console.error(`[pi-web] session_start 处理异常: ${errText(e)}`);
        }
    });

    pi.on("session_shutdown", () => {
        try {
            // 必须同步完成：退出路径不会等待异步任务
            stopServerSync();
        } catch (e) {
            console.error(`[pi-web] session_shutdown 处理异常: ${errText(e)}`);
        }
    });

    pi.on("agent_start", (event: any) => {
        try {
            agentBusy = true;
            stats.agentRuns++;
            record("agent_start", { reason: event?.reason ?? null });
        } catch {
            // 忽略统计失败
        }
    });

    pi.on("agent_end", () => {
        try {
            agentBusy = false;
            runningTool = null;
            record("agent_end", null);
        } catch {
            // 忽略统计失败
        }
    });

    pi.on("tool_execution_start", (event: any) => {
        try {
            stats.toolCalls++;
            runningTool = { name: event?.toolName ?? "?", startedAtMs: Date.now() };
            record("tool_start", { name: event?.toolName ?? "?", args: preview(event?.args, 200) });
        } catch {
            // 忽略统计失败
        }
    });

    pi.on("tool_execution_end", (event: any) => {
        try {
            if (event?.isError) stats.toolErrors++;
            record("tool_end", {
                name: event?.toolName ?? "?",
                ok: !event?.isError,
                ms: event?.durationMs ?? null,
                result: event?.isError ? preview(event?.result, 200) : null,
            });
            if (runningTool && runningTool.name === event?.toolName) runningTool = null;
        } catch {
            // 忽略统计失败
        }
    });

    pi.on("message_end", (event: any) => {
        try {
            const m = event?.message;
            if (m?.role === "assistant") {
                const text = extractText(m).trim();
                if (text) record("message", { text: text.slice(0, 240) });
            }
        } catch {
            // 忽略统计失败
        }
    });

    pi.on("session_compact", (event: any) => {
        try {
            record("compact", { reason: event?.reason ?? null });
        } catch {
            // 忽略统计失败
        }
    });

    pi.on("session_compact_failed", (event: any) => {
        try {
            record("compact_failed", {
                reason: event?.reason ?? null,
                error: event?.errorMessage ?? null,
            });
        } catch {
            // 忽略统计失败
        }
    });

    pi.on("model_select", (event: any) => {
        try {
            record("model_select", {
                provider: event?.model?.provider ?? event?.model?.provider?.id ?? null,
                id: event?.model?.id ?? null,
                source: event?.source ?? null,
            });
        } catch {
            // 忽略统计失败
        }
    });

    pi.registerCommand("web", {
        description: "显示 pi 进程管理 Web UI 的地址（RPC 模式下自动启动）",
        handler: async (_args: string, cmdCtx: any) => {
            const url = serverUrl || "（未启动：当前不在 RPC 模式，或已设置 PI_WEB_ENABLED=0）";
            try {
                await cmdCtx?.ui?.notify?.(`pi 进程管理界面: ${url}`, "info");
            } catch {
                // 无 UI 环境忽略
            }
        },
    });
}
