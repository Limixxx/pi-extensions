// sidecar RPC 消息收发：向某个已注册节点发送 RPC prompt 并取回最终回复
//
// 设计说明：
// - sidecar 监督的 pi 以 --mode rpc 运行，其 stdin 接收 JSONL 命令；
//   Windows 经命名管道、Linux 经 FIFO 转发命令（supervisor.mjs）。
// - pi 的 RPC 输出（response / session event）写在 stdout，被重定向到
//   sessions/pi-rpc.log（节点记录 pi.stdout_log）。因此"读回复"只需
//   从该节点上报的 stdout_log 尾部滚动解析 JSONL。
// - 流程：写 prompt 命令 → 等 agent_settled → 写 get_last_assistant_text
//   → 取 response 中的 data.text 作为回复。
//
// 依赖：supervisor 保持子进程 stdout 已落盘到 stdout_log（当前实现满足）。
// 支持两种路径：目标节点上报 pi.rpc_url 时经 HTTP 中继（跨机/同机均可）；未上报时回退
// 同机直连（访问节点 stdout_log 需本机文件系统权限，仅限同机拓扑）。
// 跨机推荐并默认走 HTTP 中继（relay.mjs），无需共享文件系统或直连远端命名管道。
import fs from "node:fs";
import net from "node:net";
import { log, CFG } from "./common.mjs";

export const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 300;

/**
 * 打开发送 RPC 命令的写流。
 * 返回 { write(jsonl), close() }；pipe 走 net 长连接，FIFO 每次写时打开写端。
 */
function openCommandWriter(node) {
    const kind = node?.pi?.rpc_kind;
    const rpcPath = node?.pi?.rpc_path;
    if (kind === "pipe" && rpcPath) {
        return new Promise((resolve, reject) => {
            const sock = net.connect(rpcPath);
            sock.on("connect", () =>
                resolve({
                    write: (s) => new Promise((r) => sock.write(s, r)),
                    close: () => { try { sock.destroy(); } catch { /* 忽略 */ } },
                }));
            sock.on("error", (e) => reject(new Error(`连接命名管道 ${rpcPath} 失败: ${e.message}`)));
        });
    }
    // FIFO：只写方向，每次打开写端
    return Promise.resolve({
        write: (s) => new Promise((resolve, reject) => {
            let fd;
            try {
                fd = fs.openSync(rpcPath, "w");
            } catch (e) {
                return reject(new Error(`打开 FIFO ${rpcPath} 失败: ${e.message}`));
            }
            fs.write(fd, s, (err) => {
                try { fs.closeSync(fd); } catch { /* 忽略 */ }
                err ? reject(err) : resolve();
            });
        }),
        close: () => { /* FIFO 无需保持连接 */ },
    });
}

/**
 * 向节点发送 prompt 消息并取回最终回复文本。
 * 分派：目标节点上报了 pi.rpc_url（HTTP 中继）→ HTTP 转发；否则回退到同机直连。
 * @param {object} node 节点记录
 * @param {string} message 要发送的消息
 * @param {object} [opts] { timeoutMs }
 * @returns {Promise<string|null>} 最终回复；无回复时返回 null
 */
export async function sendMessage(node, message, opts = {}) {
    const rpcUrl = node?.pi?.rpc_url;
    if (rpcUrl) return viaHttp(rpcUrl, message, opts);
    return sendMessageLocal(node, message, opts);
}

/** 经目标节点 HTTP 中继转发（跨机） */
async function viaHttp(rpcUrl, message, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const url = `${String(rpcUrl).replace(/\/+$/, "")}/api/rpc`;
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (CFG.token) headers.Authorization = `Bearer ${CFG.token}`;
    log(`经 HTTP 中继发送消息 → ${rpcUrl}: ${message}`);
    const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}${data?.error ? `: ${data.error}` : ""}`);
    }
    log(`HTTP 中继回复完成 ← ${rpcUrl}`);
    return data?.reply ?? null;
}

/**
 * 同机直连本地发送：连接节点 RPC 入口（命名管道/FIFO）写 prompt，滚动读 stdout_log 取回复。
 */
export async function sendMessageLocal(node, message, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const nodeId = node?.node_id || node?.pi?.pid || "?";
    const logPath = node?.pi?.stdout_log;
    if (!node?.pi?.rpc_path) throw new Error(`节点 ${nodeId} 未上报 RPC 入口，无法发送`);
    if (!logPath) throw new Error(`节点 ${nodeId} 未上报 stdout_log，无法读取回复`);

    // 记录滚动起点：只解析本次命令之后追加的行
    let offset = 0;
    try { offset = fs.statSync(logPath).size; } catch { /* 日志尚不存在，从 0 开始 */ }
    let lineBuf = "";

    let settled = false;
    let textRequested = false;
    let replySeen = false;
    let assistantText = null;
    let deadline = Date.now() + timeoutMs;

    const writer = await openCommandWriter(node);

    function pollTail() {
        let stat;
        try {
            stat = fs.statSync(logPath);
        } catch {
            throw new Error(`读取日志失败（stdout_log 不存在）: ${logPath}`);
        }
        if (stat.size <= offset) return;
        const chunk = fs.readFileSync(logPath, { start: offset, end: stat.size - 1 });
        offset = stat.size;
        lineBuf += chunk.toString("utf8");
        let nl;
        while ((nl = lineBuf.indexOf("\n")) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;
            let rec;
            try { rec = JSON.parse(line); } catch { /* 跳过非 JSON 行 */ continue; }
            if (rec.type === "message_end" &&
                rec.message?.role === "assistant" &&
                Array.isArray(rec.message.content)) {
                const text = rec.message.content
                    .filter((b) => b?.type === "text")
                    .map((b) => b.text || "")
                    .join("");
                if (text) assistantText = text;
            } else if (rec.type === "agent_settled") {
                settled = true;
            } else if (rec.type === "response" && rec.command === "get_last_assistant_text") {
                replySeen = true;
                if (rec.data?.text != null) assistantText = rec.data.text;
            }
        }
    }

    function send(type, extra) {
        return writer.write(JSON.stringify({ type, ...(extra || {}) }) + "\n");
    }

    try {
        log(`发送消息 → ${nodeId}: ${message}`);
        await send("prompt", { message });

        while (Date.now() <= deadline) {
            pollTail();
            if (replySeen) break;
            if (settled && !textRequested) {
                textRequested = true;
                await send("get_last_assistant_text", {});
            }
            await sleep(POLL_INTERVAL_MS);
        }

        log(`消息发送完成 ← ${nodeId}`);
        return assistantText;
    } finally {
        try { writer.close(); } catch { /* 忽略 */ }
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}