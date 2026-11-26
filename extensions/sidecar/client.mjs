// sidecar 注册客户端：slave 向 master 注册并周期心跳；master 向自身注册中心注册
// - 每次心跳重新采集本节点信息（pi pid、Web UI 地址等），pi 重启后地址自动更新
// - master 重启后返回 404 → 自动重新注册（动态上线）
// - 网络异常退避重试；优雅退出时注销（未注销则由 master 心跳超时判定下线）
import {
    CFG, PATHS, HOSTNAME, WORK_DIR, localAddresses, readInfoFile,
    readTextSafe, writeTextAtomic, log, sleep,
} from "./common.mjs";

const REQUEST_TIMEOUT_MS = 5000;
const DEREGISTER_TIMEOUT_MS = 2500;
const MAX_BACKOFF_MS = 30_000;

/** 采集本节点注册信息（每次调用重新读取 info 文件，保证 pi 重启后信息最新） */
export function buildRecord(supStats) {
    const rpc = readInfoFile(PATHS.rpcInfo);
    const web = readInfoFile(PATHS.webInfo);
    return {
        node_id: CFG.nodeId,
        hostname: HOSTNAME,
        addresses: localAddresses(),
        workdir: WORK_DIR,
        platform: process.platform,
        mode: CFG.mode,
        // 本节点系统提示内容（pi 扩展捕获写入 sessions/system-message.txt，非直接读 SYSTEM.md）
        system_md: readTextSafe(PATHS.systemPrompt) || "",
        sidecar: {
            pid: process.pid,
            started_at: supStats?.startedAtIso || "",
            restarts: supStats?.restarts ?? 0,
        },
        pi: {
            pid: Number(rpc.pi_pid) || Number(rpc.pid) || 0,
            started_at: rpc.started_at || "",
            command: rpc.command || CFG.childCmd,
            rpc_kind: rpc.pipe ? "pipe" : "fifo",
            rpc_path: rpc.pipe || rpc.fifo || "",
            web_url: web.url || "",
            web_port: Number(web.port) || 0,
            session_file: web.session_file || "",
            stdout_log: rpc.stdout_log || "",
            stderr_log: rpc.stderr_log || "",
        },
    };
}

async function postJson(path, body, timeoutMs) {
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (CFG.token) headers.Authorization = `Bearer ${CFG.token}`;
    const res = await fetch(`${CFG.masterUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
    return { status: res.status, data };
}

/** 本地留档：即便 master 不可达，本节点的注册信息也持久化在 sessions/self.json */
function persistSelf(record, extra) {
    try {
        writeTextAtomic(PATHS.selfJson, JSON.stringify({
            version: 1,
            updated_at: Date.now(),
            master_url: CFG.masterUrl,
            heartbeat_interval_ms: CFG.hbIntervalMs,
            record,
            ...extra,
        }, null, 2));
    } catch (e) {
        log(`self.json 写入失败: ${e.message}`);
    }
}

export function startRegistration({ buildRecord }) {
    let stopped = false;
    let loopPromise = null;
    let wakeUp = null;
    let everRegistered = false;
    let status = { ok: false, state: "starting", error: "", at: 0 };
    let failCount = 0;

    /** 可中断 sleep：stop() 时立即唤醒，避免退出等满一个心跳周期 */
    function sleepInterruptible(ms) {
        return new Promise((resolve) => {
            const t = setTimeout(() => { wakeUp = null; resolve(); }, ms);
            wakeUp = () => { clearTimeout(t); wakeUp = null; resolve(); };
        });
    }

    function setStatus(ok, state, error = "") {
        status = { ok, state, error, at: Date.now() };
    }

    async function beat() {
        const record = buildRecord();
        // 首次及 master 重启丢表后直接注册；其余周期心跳携带全量最新信息
        let res = everRegistered
            ? await postJson("/api/heartbeat", record, REQUEST_TIMEOUT_MS)
            : { status: 0, data: null, skip: true };
        if (!everRegistered || res.status === 404) {
            if (everRegistered) log("master 未识别本节点（可能已重启），重新注册");
            res = await postJson("/api/register", record, REQUEST_TIMEOUT_MS);
        }
        if (res.status >= 200 && res.status < 300 && res.data?.ok) {
            everRegistered = true;
            return record;
        }
        throw new Error(`HTTP ${res.status}${res.data?.error ? `: ${res.data.error}` : ""}`);
    }

    async function loop() {
        // 首次立即注册
        let delay = 0;
        while (!stopped) {
            if (delay > 0) await sleepInterruptible(delay);
            if (stopped) break;
            try {
                const record = await beat();
                if (failCount > 0) log("心跳恢复正常");
                failCount = 0;
                setStatus(true, "registered");
                persistSelf(record, { registration: status });
                delay = CFG.hbIntervalMs;
            } catch (e) {
                failCount++;
                setStatus(false, "error", e.message);
                persistSelf(buildRecord(), { registration: status });
                if (failCount === 1 || failCount % 6 === 0) {
                    log(`注册/心跳失败（第 ${failCount} 次）: ${e.message}`);
                }
                delay = Math.min(CFG.hbIntervalMs * Math.min(failCount, 5), MAX_BACKOFF_MS);
            }
        }
    }

    /** 优雅停止：尽力注销（超时放弃，由 master 心跳超时兜底） */
    async function deregister() {
        const record = buildRecord();
        try {
            const res = await postJson("/api/deregister",
                { node_id: CFG.nodeId, hostname: record.hostname }, DEREGISTER_TIMEOUT_MS);
            if (res.data?.ok) log(`已从 master 注销 ${CFG.nodeId}`);
            else log(`注销响应异常 (HTTP ${res.status})`);
        } catch (e) {
            log(`注销失败（master 将按心跳超时判定下线）: ${e.message}`);
        }
    }

    async function stop() {
        stopped = true;
        wakeUp?.();
        await deregister();
        if (loopPromise) await loopPromise.catch(() => {});
    }

    loopPromise = loop().catch((e) => log(`心跳循环异常退出: ${e.message}`));
    return { stop, status: () => status };
}
