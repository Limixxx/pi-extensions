// sidecar 进程监督模块：拉起并守护 pi（或测试替换命令），崩溃自动重启
// Linux：FIFO 以读写方式打开作为子进程 stdin（与 start.sh 原行为一致）；
// Windows：持有子进程 stdin，并创建命名管道 pi-rpc-<sha1(workdir)[:6]> 转发命令
//（与 start.ps1 原 keeper 行为一致，管道名保持兼容）。
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
    CFG, PATHS, IS_WIN, WORK_DIR, log, nowIso, writeInfoFile,
} from "./common.mjs";

const RESET_AFTER_MS = 60_000; // 存活超过该时长后重置退避计数

/** Windows 命名管道名：sha1(工作目录小写) 前 6 字节 hex，与 start.ps1 keeper 保持一致 */
export function windowsPipeName() {
    const digest = crypto.createHash("sha1").update(WORK_DIR.toLowerCase()).digest();
    return `pi-rpc-${Array.from(digest.slice(0, 6), (b) => b.toString("x2").padStart(2, "0")).join("")}`;
}

export function startSupervisor({ onStarted, onExited } = {}) {
    const st = {
        child: null,
        childPid: 0,
        childStartedAtMs: 0,
        childStartedAtIso: "",
        fifoFd: null,
        pipeServer: null,
        activeClient: null,
        logFd: null,
        errFd: null,
        restartTimer: null,
        restarts: 0,
        backoffMs: 0,
        stopping: false,
        exited: false,
    };

    function closeHandles() {
        for (const fd of [st.fifoFd, st.logFd, st.errFd]) {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch { /* 已关闭 */ }
            }
        }
        st.fifoFd = st.logFd = st.errFd = null;
        if (st.pipeServer) {
            try { st.pipeServer.close(); } catch { /* 忽略 */ }
            st.pipeServer = null;
        }
        if (st.activeClient) {
            try { st.activeClient.destroy(); } catch { /* 忽略 */ }
            st.activeClient = null;
        }
    }

    /** 确保 FIFO 存在：node 无内置 mkfifo，调用系统 mkfifo 命令 */
    function ensureFifo() {
        let isFifo = false;
        try {
            isFifo = fs.existsSync(PATHS.fifo) && fs.statSync(PATHS.fifo).isFIFO();
        } catch {
            isFifo = false;
        }
        if (isFifo) return;
        try { fs.rmSync(PATHS.fifo, { force: true }); } catch { /* 忽略 */ }
        const r = spawnSync("mkfifo", [PATHS.fifo]);
        if (r.status !== 0) {
            throw new Error(`mkfifo 失败: ${r.stderr?.toString().trim() || r.error?.message || "未知错误"}`);
        }
    }

    /** 崩溃重启统一入口：存活超过阈值重置退避；指数退避封顶 */
    function scheduleCrashRestart(uptime) {
        if (uptime > RESET_AFTER_MS) st.backoffMs = 0;
        st.backoffMs = st.backoffMs > 0 ? Math.min(st.backoffMs * 2, CFG.backoffCapMs) : 1000;
        st.restarts++;
        log(`${st.backoffMs}ms 后自动重启（第 ${st.restarts} 次）`);
        st.restartTimer = setTimeout(startPi, st.backoffMs);
        st.restartTimer.unref?.();
    }

    function writeRpcInfo(pid, pipePath) {
        const fields = {
            pid,
            pi_pid: pid,
            sidecar_pid: process.pid,
            started_at: st.childStartedAtIso,
            workdir: WORK_DIR,
            command: CFG.childCmd,
            stdout_log: PATHS.rpcLog,
            stderr_log: PATHS.rpcErrLog,
        };
        if (pipePath) {
            fields.pipe = pipePath;
        } else {
            fields.fifo = PATHS.fifo;
        }
        fs.writeFileSync(PATHS.rpcPid, `${pid}\n`, "utf8");
        writeInfoFile(PATHS.rpcInfo, fields);
    }

    /** Windows：命名管道一次服务一个客户端，字节原样写入子进程 stdin */
    function servePipe(child, pipePath) {
        const server = net.createServer((client) => {
            if (st.activeClient) {
                log(`命名管道 ${pipePath} 已有客户端，拒绝新连接`);
                client.destroy();
                return;
            }
            st.activeClient = client;
            client.on("error", () => { /* 客户端异常断开 */ });
            client.on("close", () => {
                if (st.activeClient === client) st.activeClient = null;
            });
            client.pipe(child.stdin, { end: false });
        });
        server.on("error", (e) => log(`命名管道 ${pipePath} 异常: ${e.message}`));
        server.listen(pipePath, () => log(`命名管道就绪: ${pipePath}`));
        return server;
    }

    function startPi() {
        if (st.stopping) return;
        closeHandles();
        // 清理上次运行残留的 Web 界面信息（正常退出由扩展自行清理）
        try { fs.rmSync(PATHS.webInfo, { force: true }); } catch { /* 忽略 */ }

        let child;
        let pipePath = null;
        st.childStartedAtMs = Date.now();
        st.childStartedAtIso = nowIso();
        st.logFd = fs.openSync(PATHS.rpcLog, "a");
        st.errFd = fs.openSync(PATHS.rpcErrLog, "a");

        try {
            if (IS_WIN) {
                pipePath = `\\\\.\\pipe\\${windowsPipeName()}`;
                // 与 start.ps1 keeper 相同：经 cmd 垫片拉起 pi.cmd，由本进程持有 stdin
                child = spawn(process.env.ComSpec || "cmd.exe",
                    ["/d", "/s", "/c", CFG.childCmd],
                    { cwd: WORK_DIR, env: process.env, stdio: ["pipe", st.logFd, st.errFd], windowsHide: true });
            } else {
                // FIFO 以读写方式打开，保证没有外部写入时子进程 stdin 不触发 EOF
                ensureFifo();
                st.fifoFd = fs.openSync(PATHS.fifo, "r+");
                const [cmd, ...args] = CFG.childCmd.split(/\s+/).filter(Boolean);
                child = spawn(cmd, args,
                    { cwd: WORK_DIR, env: process.env, stdio: [st.fifoFd, st.logFd, st.errFd] });
            }
        } catch (e) {
            closeHandles();
            log(`拉起子进程失败: ${e.message}`);
            if (!st.stopping) scheduleCrashRestart(0);
            return;
        }

        st.child = child;
        st.childPid = child.pid || 0;
        writeRpcInfo(st.childPid, pipePath);
        if (IS_WIN && child.stdin) {
            st.pipeServer = servePipe(child, pipePath);
            child.stdin.on("error", () => { /* 子进程退出时写端失效 */ });
        }
        log(`已拉起子进程 (pid ${st.childPid}): ${CFG.childCmd}`);
        try { onStarted?.(st.childPid, pipePath); } catch { /* 回调异常不处理 */ }

        let exitedHandled = false;
        const handleExit = (reason) => {
            if (exitedHandled) return;
            exitedHandled = true;
            const uptime = Date.now() - st.childStartedAtMs;
            closeHandles();
            st.child = null;
            st.childPid = 0;
            try { onExited?.(reason, uptime); } catch { /* 忽略 */ }
            if (st.stopping) {
                st.exited = true;
                return;
            }
            scheduleCrashRestart(uptime);
        };

        child.on("exit", (code, signal) => {
            log(`子进程退出 (pid ${st.childPid} code=${code} signal=${signal})`);
            handleExit("exit");
        });
        child.on("error", (e) => {
            log(`子进程异常: ${e.message}`);
            handleExit("error");
        });
    }

    /** 优雅停止：不再重启 → 结束子进程（等待 stopTimeoutMs 后强杀） */
    function stopGraceful() {
        if (st.stopping) return Promise.resolve();
        st.stopping = true;
        if (st.restartTimer) clearTimeout(st.restartTimer);
        const child = st.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) {
            closeHandles();
            st.exited = true;
            return Promise.resolve();
        }
        log("正在停止子进程…");
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve();
            };
            child.once("exit", () => {
                closeHandles();
                st.exited = true;
                log("子进程已退出");
                finish();
            });
            try {
                if (IS_WIN) {
                    // 关闭 stdin 触发有序退出；命名管道客户端一并断开
                    st.activeClient?.destroy();
                    child.stdin?.end();
                } else {
                    child.kill("SIGTERM");
                }
            } catch (e) {
                log(`发送停止信号失败: ${e.message}`);
            }
            setTimeout(() => {
                if (done) return;
                log(`等待 ${Math.round(CFG.stopTimeoutMs / 1000)}s 仍未退出，强制结束`);
                try {
                    if (IS_WIN) {
                        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
                    } else {
                        child.kill("SIGKILL");
                    }
                } catch { /* 忽略 */ }
                // 强杀后再兜底等待
                setTimeout(finish, 2000);
            }, CFG.stopTimeoutMs).unref?.();
        });
    }

    function stats() {
        return {
            childPid: st.childPid,
            childStartedAtMs: st.childStartedAtMs,
            childStartedAtIso: st.childStartedAtIso,
            restarts: st.restarts,
            stopping: st.stopping,
        };
    }

    // 启动
    startPi();
    return { stopGraceful, stats };
}
