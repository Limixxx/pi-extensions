// sidecar 共享配置与工具：路径、环境变量解析、info 文件读写
// 仅使用 node 内置模块；所有日志走 stderr。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const IS_WIN = process.platform === "win32";

// extensions/sidecar/common.mjs → .pi/ → 项目根
export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PI_DIR = path.resolve(SCRIPT_DIR, "..", "..");
export const WORK_DIR = path.dirname(PI_DIR);
export const SESS_DIR = path.join(PI_DIR, "sessions");

/** 各运行时文件路径（均在 sessions/ 下，不入库） */
export const PATHS = {
    rpcPid: path.join(SESS_DIR, "pi-rpc.pid"),
    rpcInfo: path.join(SESS_DIR, "pi-rpc.info"),
    fifo: path.join(SESS_DIR, "pi-rpc.fifo"),
    rpcLog: path.join(SESS_DIR, "pi-rpc.log"),
    rpcErrLog: path.join(SESS_DIR, "pi-rpc.err.log"),
    webInfo: path.join(SESS_DIR, "pi-web.info"),
    sidecarPid: path.join(SESS_DIR, "pi-sidecar.pid"),
    sidecarInfo: path.join(SESS_DIR, "pi-sidecar.info"),
    sidecarLog: path.join(SESS_DIR, "pi-sidecar.log"),
    stopFlag: path.join(SESS_DIR, "pi-sidecar.stop"),
    registryJson: path.join(SESS_DIR, "registry.json"),
    selfJson: path.join(SESS_DIR, "self.json"),
};

function envStr(name) {
    return (process.env[name] || "").trim();
}

function envInt(name, def, { min = 1, max = 86_400_000 } = {}) {
    const v = Number.parseInt(envStr(name), 10);
    if (!Number.isFinite(v)) return def;
    return Math.min(Math.max(v, min), max);
}

/** 归一化 master 地址：补 http:// 前缀、去尾部斜杠 */
function normalizeUrl(u) {
    let s = u.trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
    return s.replace(/\/+$/, "");
}

// ===== settings.json 配置（可选，优先级高于环境变量） =====
// 读取项目 <cwd>/.pi/settings.json 与用户 ~/.pi/agent/settings.json 的 "sidecar" 字段，
// 取其值覆盖环境变量参与配置解析。仅让值生效，不改写 process.env。
// settings.json 示例：
//   {
//     "sidecar": {
//       "masterUrl": "http://master-host:3180",
//       "mode": "master",              // master | slave | auto（缺省 auto）
//       "registryHost": "0.0.0.0",
//       "registryPort": 3180,
//       "token": "your-token",
//       "nodeId": "my-node",
//       "heartbeatInterval": 10,       // 秒
//       "heartbeatTimeout": 30,        // 秒
//       "offlineRetention": 3600,      // 秒
//       "backoffCap": 30,              // 秒
//       "stopTimeout": 15,             // 秒
//       "childCmd": "pi --mode rpc --approve"
//     }
//   }

function loadSettingsSidecar() {
    const out = {};
    const projectPath = path.join(PI_DIR, "settings.json");
    const userPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
    // 用户级在前、项目级在后：后写入者覆盖前者（项目级优先级更高）
    const files = [];
    if (userPath !== projectPath) files.push(userPath);
    files.push(projectPath);
    for (const f of files) {
        try {
            if (!fs.existsSync(f)) continue;
            const data = JSON.parse(fs.readFileSync(f, "utf8"));
            const sc = data && typeof data === "object" ? data.sidecar : undefined;
            if (sc && typeof sc === "object") Object.assign(out, sc);
        } catch (e) {
            log(`读取 settings.json 失败(${f}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return out;
}

const SETTINGS = loadSettingsSidecar();

function settingStr(key) {
    const v = SETTINGS[key];
    if (v === undefined || v === null) return undefined;
    return typeof v === "string" ? v : String(v);
}

function settingInt(key) {
    const v = SETTINGS[key];
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (Number.isInteger(n) && Number.isFinite(n)) return n;
    return undefined;
}

function resolveStr(key, envName) {
    const s = settingStr(key);
    if (s !== undefined) return s.trim();
    return envStr(envName);
}

function resolveInt(key, envName, def, { min = 1, max = 86_400_000 } = {}) {
    const s = settingInt(key);
    if (s !== undefined) return Math.min(Math.max(s, min), max);
    return envInt(envName, def, { min, max });
}

export const CFG = (() => {
    const masterUrl = normalizeUrl(resolveStr("masterUrl", "PI_SIDECAR_MASTER_URL"));
    const rawMode = (resolveStr("mode", "PI_SIDECAR_MODE") || "").toLowerCase();
    // 模式：显式 master|slave；缺省 auto —— 配了 master 地址则为 slave，否则为 master
    let mode = rawMode;
    if (mode !== "master" && mode !== "slave") {
        mode = masterUrl ? "slave" : "master";
    }
    const registryHost = resolveStr("registryHost", "PI_SIDECAR_REGISTRY_HOST") || "127.0.0.1";
    const registryPort = resolveInt("registryPort", "PI_SIDECAR_REGISTRY_PORT", 3180, { min: 1, max: 65535 });
    return {
        rawMode,
        mode,
        // master 的"注册目标"是自身回环地址；slave 的注册目标是远端 master
        masterUrl: mode === "master" ? `http://127.0.0.1:${registryPort}` : masterUrl,
        registryUrl: `http://${registryHost}:${registryPort}`,
        registryHost,
        registryPort,
        token: resolveStr("token", "PI_SIDECAR_TOKEN"),
        nodeId:
            resolveStr("nodeId", "PI_SIDECAR_NODE_ID") ||
            `${os.hostname()}-${crypto.createHash("sha1").update(WORK_DIR).digest("hex").slice(0, 6)}`,
        hbIntervalMs: resolveInt("heartbeatInterval", "PI_SIDECAR_HEARTBEAT_INTERVAL", 10) * 1000,
        hbTimeoutMs: resolveInt("heartbeatTimeout", "PI_SIDECAR_HEARTBEAT_TIMEOUT", 30) * 1000,
        retentionMs: resolveInt("offlineRetention", "PI_SIDECAR_OFFLINE_RETENTION", 3600) * 1000,
        backoffCapMs: resolveInt("backoffCap", "PI_SIDECAR_BACKOFF_CAP", 30) * 1000,
        stopTimeoutMs: resolveInt("stopTimeout", "PI_STOP_TIMEOUT", 15) * 1000,
        // 被监督子进程命令（PI_SIDECAR_CHILD_CMD 仅用于测试替换）
        childCmd: resolveStr("childCmd", "PI_SIDECAR_CHILD_CMD") || "pi --mode rpc --approve",
    };
})();

export const HOSTNAME = os.hostname();

/** 本机对外 IPv4 地址列表（排除回环） */
export function localAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const it of list || []) {
            if (it.family === "IPv4" && !it.internal) out.push(it.address);
        }
    }
    return out;
}

export function log(msg) {
    console.error(`[sidecar ${new Date().toISOString()}] ${msg}`);
}

export function nowIso() {
    return new Date().toISOString();
}

export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** 判断 pid 是否存活 */
export function alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === "EPERM"; // 无权限时按存活处理
    }
}

/** 解析 key=value 行式 info 文件（缺失/损坏返回 {}） */
export function readInfoFile(p) {
    const out = {};
    try {
        const text = fs.readFileSync(p, "utf8");
        for (const line of text.split(/\r?\n/)) {
            const i = line.indexOf("=");
            if (i > 0) {
                const k = line.slice(0, i).trim();
                const v = line.slice(i + 1).trim();
                if (k) out[k] = v;
            }
        }
    } catch {
        // 文件不存在等情况返回空对象
    }
    return out;
}

/** 写 key=value 行式 info 文件（直接覆盖） */
export function writeInfoFile(p, fields) {
    const body =
        Object.entries(fields)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n") + "\n";
    fs.writeFileSync(p, body, "utf8");
}

/** 原子写文本（临时文件 + rename），用于 JSON 持久化 */
export function writeTextAtomic(p, text) {
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, p);
}

/** 安全读 JSON（缺失/损坏返回 null） */
export function readJsonSafe(p) {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return null;
    }
}
