// sidecar master 模式：HTTP 注册中心
// - 接收 slave / master 自身的注册、心跳与注销（JSON over HTTP）
// - 注册表持久化到 sessions/registry.json（临时文件 + rename 原子写）
// - 周期扫描心跳：超时标记 offline，长期离线自动清理（动态上下线）
import http from "node:http";
import {
    CFG, PATHS, readJsonSafe, writeTextAtomic, log, nowIso,
} from "./common.mjs";

const MAX_BODY_BYTES = 256 * 1024;

/** 计算节点状态：心跳未超时即 online */
export function computeStatus(rec, now = Date.now()) {
    return now - (rec.last_heartbeat || 0) <= CFG.hbTimeoutMs ? "online" : "offline";
}

export function startRegistry() {
    const nodes = new Map(); // node_id -> 记录（含 registered_at / last_heartbeat / status）
    let persistTimer = null;
    let sweepTimer = null;
    let server = null;
    let startedAtMs = Date.now();

    // ── 持久化 ──────────────────────────────────────────────
    function loadPersisted() {
        const data = readJsonSafe(PATHS.registryJson);
        if (data && typeof data === "object" && data.nodes && typeof data.nodes === "object") {
            for (const [id, rec] of Object.entries(data.nodes)) {
                if (id && rec && typeof rec === "object") nodes.set(id, rec);
            }
            log(`已加载注册表：${nodes.size} 个节点（重启后等待心跳刷新状态）`);
        }
    }

    function persistNow() {
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        try {
            const data = {
                version: 1,
                node_id: CFG.nodeId,
                updated_at: Date.now(),
                nodes: Object.fromEntries(nodes),
            };
            writeTextAtomic(PATHS.registryJson, JSON.stringify(data, null, 2));
        } catch (e) {
            log(`注册表持久化失败: ${e.message}`);
        }
    }

    function persistSoon() {
        if (persistTimer) return;
        persistTimer = setTimeout(persistNow, 500);
        persistTimer.unref?.();
    }

    // ── 心跳扫描：超时 offline、长期离线清理 ────────────────
    function sweep() {
        const now = Date.now();
        let changed = false;
        for (const [id, rec] of nodes) {
            const status = computeStatus(rec, now);
            if (status !== rec.status) {
                rec.status = status;
                if (status === "offline") log(`节点 ${id} 心跳超时，标记为 offline`);
                changed = true;
            }
            if (status === "offline" && now - rec.last_heartbeat > CFG.retentionMs) {
                nodes.delete(id);
                log(`节点 ${id} 离线超过保留期，已从注册表清理`);
                changed = true;
            }
        }
        if (changed) persistSoon();
    }

    // ── 记录合并 ────────────────────────────────────────────
    function upsert(payload, { isRegister }) {
        const id = String(payload?.node_id || "").trim();
        const now = Date.now();
        const prev = nodes.get(id);
        const rec = {
            ...payload,
            node_id: id,
            registered_at: prev?.registered_at && !isRegister ? prev.registered_at : now,
            last_heartbeat: now,
            status: "online",
        };
        nodes.set(id, rec);
        persistSoon();
        return rec;
    }

    // ── HTTP 工具 ───────────────────────────────────────────
    function sendJson(res, code, obj) {
        const body = JSON.stringify(obj);
        res.writeHead(code, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body),
            "Cache-Control": "no-store",
        });
        res.end(body);
    }

    function readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on("data", (c) => {
                size += c.length;
                if (size > MAX_BODY_BYTES) {
                    reject(new Error("body 超过 256KB"));
                    req.destroy();
                    return;
                }
                chunks.push(c);
            });
            req.on("end", () => {
                try {
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(new Error(`JSON 解析失败: ${e.message}`));
                }
            });
            req.on("error", reject);
        });
    }

    /** 鉴权：设置 PI_SIDECAR_TOKEN 后 /api/* 与状态页需携带 Bearer 或 ?token= */
    function authorized(req, urlObj) {
        if (!CFG.token) return true;
        const header = req.headers.authorization || "";
        if (header === `Bearer ${CFG.token}`) return true;
        if (urlObj.searchParams.get("token") === CFG.token) return true;
        return false;
    }

    function htmlPage() {
        const now = Date.now();
        const rows = [...nodes.values()].map((rec) => {
            const status = computeStatus(rec, now);
            const color = status === "online" ? "#0a0" : "#c00";
            const pi = rec.pi || {};
            const addr = (rec.addresses || []).join(", ") || "-";
            const hb = rec.last_heartbeat ? `${Math.round((now - rec.last_heartbeat) / 1000)}s 前` : "-";
            const web = pi.web_url
                ? `<a href="${pi.web_url}" target="_blank">${pi.web_url}</a>`
                : "-";
            return `<tr>
<td>${esc(rec.node_id)}</td><td>${esc(rec.hostname || "-")}<br><small>${esc(addr)}</small></td>
<td>${esc(rec.mode || "-")}</td><td style="color:${color}">${status}</td>
<td>${pi.pid ?? "-"}</td><td>${web}</td><td><small>${esc(pi.rpc_path || "-")}</small></td>
<td>${hb}</td></tr>`;
        }).join("\n");
        return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="5"><title>pi sidecar 注册中心</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;background:#fafafa;color:#222}
table{border-collapse:collapse;background:#fff;box-shadow:0 1px 3px #0002}
th,td{border:1px solid #ddd;padding:6px 10px;font-size:14px;text-align:left;vertical-align:top}
th{background:#f0f0f0}small{color:#888}h1{font-size:20px}</style></head><body>
<h1>pi sidecar 注册中心 — ${esc(CFG.nodeId)}</h1>
<p><small>节点 ${nodes.size} 个 · 心跳超时 ${Math.round(CFG.hbTimeoutMs / 1000)}s · 页面每 5s 自动刷新 · 数据接口 <code>GET /api/nodes</code></small></p>
<table><thead><tr><th>节点 ID</th><th>主机</th><th>模式</th><th>状态</th><th>pi pid</th><th>Web UI</th><th>RPC 入口</th><th>最近心跳</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8">暂无注册节点</td></tr>'}</tbody></table></body></html>`;
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    // ── 请求处理 ────────────────────────────────────────────
    async function handler(req, res) {
        const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const p = decodeURIComponent(urlObj.pathname);

        try {
            if (p === "/healthz") {
                const online = [...nodes.values()].filter((r) => computeStatus(r) === "online").length;
                return sendJson(res, 200, {
                    ok: true, mode: "master", node_id: CFG.nodeId,
                    uptime_s: Math.round((Date.now() - startedAtMs) / 1000),
                    nodes_total: nodes.size, nodes_online: online,
                });
            }
            if (!authorized(req, urlObj)) {
                return sendJson(res, 401, { ok: false, error: "unauthorized" });
            }
            if (req.method === "GET" && (p === "/" || p === "/index.html")) {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
                return res.end(htmlPage());
            }
            if (p === "/api/nodes") {
                const now = Date.now();
                return sendJson(res, 200, {
                    ok: true, now, heartbeat_timeout_ms: CFG.hbTimeoutMs,
                    nodes: [...nodes.values()].map((r) => ({ ...r, status: computeStatus(r, now) })),
                });
            }
            const mNode = p.match(/^\/api\/nodes\/([^/]+)$/);
            if (req.method === "GET" && mNode) {
                const rec = nodes.get(mNode[1]);
                if (!rec) return sendJson(res, 404, { ok: false, error: `unknown node: ${mNode[1]}` });
                return sendJson(res, 200, { ok: true, node: { ...rec, status: computeStatus(rec) } });
            }
            if (req.method === "POST" && p === "/api/register") {
                const payload = await readBody(req);
                if (!payload?.node_id) return sendJson(res, 400, { ok: false, error: "node_id is required" });
                const rec = upsert(payload, { isRegister: !nodes.has(String(payload.node_id).trim()) });
                log(`节点注册: ${rec.node_id}（共 ${nodes.size} 个）`);
                return sendJson(res, 200, {
                    ok: true, node_id: rec.node_id,
                    heartbeat_interval_ms: CFG.hbIntervalMs, heartbeat_timeout_ms: CFG.hbTimeoutMs,
                });
            }
            if (req.method === "POST" && p === "/api/heartbeat") {
                const payload = await readBody(req);
                const id = String(payload?.node_id || "").trim();
                const prev = nodes.get(id);
                if (!prev) return sendJson(res, 404, { ok: false, error: "unknown node_id" });
                upsert(payload, { isRegister: false });
                return sendJson(res, 200, { ok: true, node_id: id, status: "online" });
            }
            if (req.method === "POST" && p === "/api/deregister") {
                const payload = await readBody(req);
                const id = String(payload?.node_id || "").trim();
                if (nodes.delete(id)) log(`节点注销: ${id}（剩余 ${nodes.size} 个）`);
                persistSoon();
                return sendJson(res, 200, { ok: true });
            }
            sendJson(res, 404, { ok: false, error: `not found: ${req.method} ${p}` });
        } catch (e) {
            log(`请求处理异常 ${req.method} ${p}: ${e.message}`);
            try { sendJson(res, 400, { ok: false, error: e.message }); } catch { /* 已响应 */ }
        }
    }

    // ── 生命周期 ────────────────────────────────────────────
    function close({ persist = true } = {}) {
        if (sweepTimer) clearInterval(sweepTimer);
        if (persist) persistNow();
        return new Promise((resolve) => {
            if (!server) return resolve();
            server.close(() => resolve());
            // 无活跃连接时立即完成
            server.closeAllConnections?.();
            setTimeout(resolve, 1000).unref?.();
        });
    }

    loadPersisted();

    return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => { void handler(req, res); });
        server.on("error", (e) => {
            log(`注册中心监听失败 ${CFG.registryHost}:${CFG.registryPort}: ${e.message}`);
            reject(e);
        });
        server.listen(CFG.registryPort, CFG.registryHost, () => {
            const sweepMs = Math.min(Math.max(Math.round(CFG.hbTimeoutMs / 3), 1000), 5000);
            sweepTimer = setInterval(sweep, sweepMs);
            sweepTimer.unref?.();
            log(`注册中心已启动: ${CFG.registryUrl}（心跳间隔 ${Math.round(CFG.hbIntervalMs / 1000)}s，` +
                `超时 ${Math.round(CFG.hbTimeoutMs / 1000)}s，离线保留 ${Math.round(CFG.retentionMs / 60000)}min）`);
            resolve({ url: CFG.registryUrl, close, stats: () => ({ size: nodes.size, startedAtMs }) });
        });
    });
}
