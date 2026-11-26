// sidecar RPC 中继（每节点）：将收到的 HTTP 消息投递给本机被监督的 pi 子进程并返回回复。
//
// 跨机消息的落点：master 的 /api/message 拿到目标节点后，经其 pi.rpc_url 把消息转发到本中继。
// 中继只操作本机资源（本机 RPC stdin 管道/FIFO + 本机 stdout_log），因此天然跨机可用——
// 远程 master 不必也不该触碰目标节点的本地管道/日志。
//
// 端点：
//   POST /api/rpc   body {message} → {ok, node_id, reply}
//   GET  /healthz                   状态
// 携带 samehost 鉴权：设置 PI_SIDECAR_TOKEN 后需 Authorization: Bearer <token>。
import http from "node:http";
import {
    CFG, PATHS, readInfoFile,
} from "./common.mjs";
import { sendMessageLocal } from "./message.mjs";

/** 本节点的本地投递对象：只含 sendMessageLocal 需要的字段 */
function localNode() {
    const rpc = readInfoFile(PATHS.rpcInfo);
    return {
        node_id: CFG.nodeId,
        pi: {
            rpc_kind: rpc.pipe ? "pipe" : "fifo",
            rpc_path: rpc.pipe || rpc.fifo || "",
            stdout_log: PATHS.rpcLog,
        },
    };
}

export function startRelay({ timeoutMs = 120_000 } = {}) {
    const server = http.createServer((req, res) => {
        void (async () => {
            try {
                const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
                const p = u.pathname;
                if (req.method === "GET" && p === "/healthz") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, node_id: CFG.nodeId }));
                    return;
                }
                if (req.method === "POST" && p === "/api/rpc") {
                    const body = await readChunk(req);
                    let payload = {};
                    try { payload = JSON.parse(body || "{}"); } catch { /* 保留空对象 */ }
                    if (CFG.token) {
                        const auth = req.headers.authorization || "";
                        if (auth !== `Bearer ${CFG.token}`) {
                            res.writeHead(401, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
                            return;
                        }
                    }
                    const message = String(payload?.message || "").trim();
                    if (!message) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: false, error: "message is required" }));
                        return;
                    }
                    const reply = await sendMessageLocal(localNode(), message, { timeoutMs });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, node_id: CFG.nodeId, reply }));
                    return;
                }
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: `not found: ${req.method} ${p}` }));
            } catch (e) {
                const msg = e.message || String(e);
                try {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: msg }));
                } catch { /* 已响应 */ }
            }
        })();
    });

    return new Promise((resolve, reject) => {
        server.on("error", (e) => {
            reject(new Error(`RPC 中继监听失败 ${CFG.relayHost}:${CFG.relayPort}: ${e.message}`));
        });
        server.listen(CFG.relayPort, CFG.relayHost, () => {
            resolve({
                url: CFG.relayUrl,
                port: CFG.relayPort,
                close: () => new Promise((r) => {
                    try { server.close(() => r()); server.closeAllConnections?.(); } catch { r(); }
                    setTimeout(r, 500).unref?.();
                }),
            });
        });
    });
}

function readChunk(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}