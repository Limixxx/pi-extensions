#!/usr/bin/env node
// pi sidecar 守护进程（入口）
//
// 职责：
//  1. 进程守护：拉起 pi --mode rpc --approve 作为子进程，崩溃后指数退避自动重启
//  2. 随 stop 脚本停止：SIGTERM/SIGINT（Linux）或停止标记文件 sessions/pi-sidecar.stop（跨平台）
//  3. master / slave 两种模式：
//     - master：本机运行 HTTP 注册中心（默认 127.0.0.1:3180），并把自己注册进去
//     - slave：启动时向 PI_SIDECAR_MASTER_URL 注册本节点（Web UI 地址、RPC 入口等），周期心跳
//  4. 注册信息持久化：master 写 sessions/registry.json，所有节点本地留档 sessions/self.json
//  5. 心跳检测：master 侧超时标记 offline、恢复心跳自动 online、长期离线清理（动态上下线）
//
// 用法：由 scripts/start.sh / start.ps1 后台拉起（node extensions/sidecar/sidecar.mjs），
//       配置全部来自环境变量（见 .env.example 的 PI_SIDECAR_* 说明）。
// 本文件仅用 node 内置模块；所有日志走 stderr。
import fs from "node:fs";
import {
    CFG, PATHS, IS_WIN, SESS_DIR, WORK_DIR, log, nowIso, alive,
    writeInfoFile,
} from "./common.mjs";
import { startSupervisor } from "./supervisor.mjs";
import { startRegistry } from "./registry.mjs";
import { startRegistration, buildRecord } from "./client.mjs";

process.title = "pi-sidecar";
const STARTED_AT_MS = Date.now();
const STARTED_AT_ISO = nowIso();

log(`sidecar 启动 (pid ${process.pid})：mode=${CFG.mode}，node_id=${CFG.nodeId}，master=${CFG.masterUrl}`);

// ── 目录与单实例检查 ──────────────────────────────────────
fs.mkdirSync(SESS_DIR, { recursive: true });
// 清理上次运行残留的停止标记（仅对运行中的实例有意义）
try { fs.rmSync(PATHS.stopFlag, { force: true }); } catch { /* 忽略 */ }

function readPidFile(p) {
    try {
        return Number.parseInt(fs.readFileSync(p, "utf8").trim(), 10) || 0;
    } catch {
        return 0;
    }
}
const staleSidecarPid = readPidFile(PATHS.sidecarPid);
if (staleSidecarPid !== process.pid && alive(staleSidecarPid)) {
    log(`sidecar 已在运行 (pid ${staleSidecarPid})，退出`);
    process.exit(1);
}
const staleRpcPid = readPidFile(PATHS.rpcPid);
if (alive(staleRpcPid)) {
    log(`检测到 pi 已在运行 (pid ${staleRpcPid}，可能由旧版脚本直接启动)，sidecar 不接管，退出`);
    log("如需切换到 sidecar 托管，请先执行 scripts/stop.sh");
    process.exit(1);
}

// ── pid / info 文件 ──────────────────────────────────────
fs.writeFileSync(PATHS.sidecarPid, `${process.pid}\n`, "utf8");
function writeSidecarInfo(extra = {}) {
    writeInfoFile(PATHS.sidecarInfo, {
        pid: process.pid,
        mode: CFG.mode,
        node_id: CFG.nodeId,
        started_at: STARTED_AT_ISO,
        workdir: WORK_DIR,
        registry_url: CFG.registryUrl,
        master_url: CFG.masterUrl,
        heartbeat_interval_s: Math.round(CFG.hbIntervalMs / 1000),
        heartbeat_timeout_s: Math.round(CFG.hbTimeoutMs / 1000),
        child_cmd: CFG.childCmd,
        ...extra,
    });
}
writeSidecarInfo();

// ── 核心组件 ─────────────────────────────────────────────
const state = { stopping: false, stopPromise: null };
let registry = null; // master 模式的注册中心句柄
let registration = null;

const supervisor = startSupervisor({
    onStarted: (pid) => {
        log(`子进程运行中 (pid ${pid})，心跳会自动携带最新地址信息`);
    },
    onExited: (reason, uptime) => {
        if (state.stopping) return;
        log(`子进程异常退出 (reason=${reason}, 存活 ${Math.round(uptime / 1000)}s)，进入自动重启流程`);
    },
});

function recordBuilder() {
    return buildRecord({ ...supervisor.stats(), startedAtIso: STARTED_AT_ISO });
}

// ── 优雅停止 ─────────────────────────────────────────────
async function gracefulStop(reason) {
    if (state.stopping) return state.stopPromise;
    state.stopping = true;
    state.stopPromise = (async () => {
        log(`收到停止请求（${reason}），开始优雅停止…`);
        try {
            await supervisor.stopGraceful();             // 1. 停止子进程（含等待与强杀）
            if (registration) await registration.stop(); // 2. 从 master 注销（尽力而为）
            if (registry) await registry.close();        // 3. 落盘注册表并关闭监听
        } catch (e) {
            log(`停止流程异常: ${e.message}`);
        }
        for (const f of [PATHS.sidecarPid, PATHS.stopFlag, PATHS.rpcPid, PATHS.rpcInfo]) {
            try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
        }
        if (!IS_WIN) {
            try { fs.rmSync(PATHS.fifo, { force: true }); } catch { /* 忽略 */ }
        }
        log(`sidecar 已停止（运行 ${Math.round((Date.now() - STARTED_AT_MS) / 1000)}s）`);
        process.exit(0);
    })();
    return state.stopPromise;
}

process.on("SIGTERM", () => void gracefulStop("SIGTERM"));
process.on("SIGINT", () => void gracefulStop("SIGINT"));
process.on("SIGHUP", () => log("忽略 SIGHUP"));
process.on("uncaughtException", (e) => log(`未捕获异常（继续运行）: ${e.stack || e.message}`));
process.on("unhandledRejection", (e) => log(`未处理的 Promise 拒绝（继续运行）: ${e}`));

// 停止标记轮询：Windows 无法向进程投递可捕获的信号，stop 脚本写标记文件后本进程自行退出
setInterval(() => {
    if (fs.existsSync(PATHS.stopFlag)) void gracefulStop("stop-flag");
}, 500).unref?.();

// ── master：启动注册中心 ─────────────────────────────────
if (CFG.mode === "master") {
    try {
        registry = await startRegistry();
        writeSidecarInfo({ registry_url: registry.url });
    } catch {
        log("注册中心启动失败，sidecar 退出（请检查 PI_SIDECAR_REGISTRY_HOST/PORT 是否被占用）");
        await gracefulStop("registry-bind-failed");
    }
}

// ── 注册与心跳（master 注册到自身，slave 注册到远端）─────
registration = startRegistration({ buildRecord: recordBuilder });

log(`sidecar 就绪：mode=${CFG.mode}，node_id=${CFG.nodeId}` +
    `${CFG.mode === "master" ? `，注册中心 ${CFG.registryUrl}` : `，master ${CFG.masterUrl}`}`);
