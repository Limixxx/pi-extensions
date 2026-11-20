// @ts-ignore
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
// @ts-ignore
import { Type } from "typebox";
// @ts-ignore
import { execFile } from "node:child_process";
// @ts-ignore
import { readFileSync } from "node:fs";
// @ts-ignore
import { dirname, join } from "node:path";
// @ts-ignore
import { fileURLToPath } from "node:url";

/**
 * kubectl 命令工具扩展
 *
 * 注册一个名为 `kubectl` 的模型工具，通过 `kubectl.tools` 白名单文件
 * 控制允许执行的 kubectl 子命令，白名单之外的子命令一律拒绝（默认拒绝）。
 *
 * 白名单文件默认与本扩展同目录（.pi/extensions/kubectl.tools），
 * 可通过环境变量 KUBECTL_TOOLS_FILE 指定其他路径。
 * 每次工具调用时重新读取，修改后立即生效，无需重启。
 */

// ============================================================
// 常量
// ============================================================

/** 扩展所在目录 */
const EXT_DIR = dirname(fileURLToPath(import.meta.url));

/** 输出上限：与内置工具一致（50KB / 2000 行） */
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

/** 执行超时（秒） */
const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 600;

// ============================================================
// 白名单
// ============================================================

interface WhitelistInfo {
  /** 归一化后的条目，每条为子命令 token 列表（如 ["get", "pods"]） */
  entries: string[][];
  /** 白名单文件是否存在 */
  exists: boolean;
  /** 白名单文件路径 */
  path: string;
}

/** 白名单文件路径，可用环境变量 KUBECTL_TOOLS_FILE 覆盖 */
function whitelistPath(): string {
  return process.env.KUBECTL_TOOLS_FILE || join(EXT_DIR, "kubectl.tools");
}

/**
 * 按空白切分命令，支持单/双引号保留空格（引号本身会被去掉）。
 * 不经过 shell，重定向与管道符只会作为普通参数传给 kubectl。
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let started = false;
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}

/**
 * 取开头连续的非 flag token 作为子命令路径，遇到以 `-` 开头的 token 即停止。
 * 例如 ["get", "pods", "-n", "default"] -> ["get", "pods"]
 */
function commandPathOf(tokens: string[]): string[] {
  const path: string[] = [];
  for (const t of tokens) {
    if (t.startsWith("-")) break;
    path.push(t);
  }
  return path;
}

/** 读取并解析白名单文件（每次调用时重新读取） */
function loadWhitelist(): WhitelistInfo {
  const path = whitelistPath();
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return { entries: [], exists: false, path };
  }
  const entries: string[][] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let tokens = tokenize(line);
    if (tokens[0]?.toLowerCase() === "kubectl") tokens = tokens.slice(1);
    const sub = commandPathOf(tokens);
    if (sub.length > 0 && !entries.some((e) => e.join("\u0000") === sub.join("\u0000"))) {
      entries.push(sub);
    }
  }
  return { entries, exists: true, path };
}

/** 子命令路径是否被某个白名单条目前缀匹配（条目 "get" 匹配 ["get","pods"]） */
function isAllowed(cmd: string[], entries: string[][]): boolean {
  return entries.some(
    (e) => e.length > 0 && e.length <= cmd.length && e.every((t, i) => t === cmd[i]),
  );
}

// ============================================================
// 输出处理
// ============================================================

/** 截断超长输出（保留头部），并提示截断信息 */
function truncateOutput(text: string): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (!text || (lines.length <= MAX_LINES && totalBytes <= MAX_BYTES)) {
    return { text, truncated: false };
  }
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const n = Buffer.byteLength(line, "utf8") + 1;
    if (kept.length >= MAX_LINES || bytes + n > MAX_BYTES) {
      const note =
        `\n\n[输出已截断: 保留前 ${kept.length}/${lines.length} 行` +
        ` (${formatBytes(bytes)}/${formatBytes(totalBytes)})。` +
        `如需完整结果，请用更窄的条件分批查询（如 -l 选择器、-o name、--field-selector）。]`;
      return { text: kept.join("\n") + note, truncated: true };
    }
    kept.push(line);
    bytes += n;
  }
  return { text, truncated: false };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// ============================================================
// kubectl 执行
// ============================================================

interface KubectlRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  notFound: boolean;
}

/** 用 execFile（无 shell）执行 kubectl，避免 shell 注入 */
function runKubectl(
  args: string[],
  timeoutSec: number,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
): Promise<KubectlRunResult> {
  return new Promise((resolve) => {
    execFile(
      "kubectl",
      args,
      {
        encoding: "utf-8",
        timeout: timeoutSec * 1000,
        maxBuffer: 100 * 1024 * 1024,
        windowsHide: true,
        cwd,
        ...(signal ? { signal } : {}),
      },
      (err: any, stdout: string, stderr: string) => {
        if (signal?.aborted) {
          resolve({ stdout, stderr, exitCode: null, timedOut: false, aborted: true, notFound: false });
          return;
        }
        if (err && err.code === "ENOENT") {
          resolve({ stdout, stderr, exitCode: null, timedOut: false, aborted: false, notFound: true });
          return;
        }
        const timedOut = err?.killed === true && err?.signal === "SIGTERM";
        resolve({
          stdout,
          stderr,
          exitCode: typeof err?.code === "number" ? err.code : err ? null : 0,
          timedOut,
          aborted: false,
          notFound: false,
        });
      },
    );
  });
}

// ============================================================
// 扩展入口
// ============================================================

export default function (pi: ExtensionAPI) {
  // ──────────────────────────────────────────────────────────
  // kubectl — 白名单管控的 kubectl 命令工具
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "kubectl",
    label: "kubectl",
    description:
      "执行 kubectl 命令（受 kubectl.tools 白名单管控，默认拒绝）。" +
      "command 为 kubectl 之后的完整参数，例如 'get pods -n kube-system -o wide'（开头多余的 kubectl 前缀会被忽略）。" +
      "仅允许白名单中列出的子命令，按前缀匹配：条目 'get' 允许所有 kubectl get ...，条目 'get pods' 仅允许 kubectl get pods ...。" +
      "全局 flag（如 -n/--context/-o）必须放在子命令之后，放在最前面会被拒绝。" +
      "直接经 shell 执行（管道、重定向等）不支持；需要组合处理时先取回结果再分析。",

    parameters: Type.Object({
      command: Type.String({
        description:
          "kubectl 命令参数（可含开头的 kubectl 前缀），如 'get pods -n default'、'kubectl version --client'",
      }),
      timeout: Type.Optional(
        Type.Number({ description: `超时秒数，默认 ${DEFAULT_TIMEOUT_SEC}，最大 ${MAX_TIMEOUT_SEC}` }),
      ),
    }),

    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const started = Date.now();
      const rawTimeout = Number(params.timeout);
      const timeoutSec =
        Number.isFinite(rawTimeout) && rawTimeout > 0
          ? Math.min(Math.round(rawTimeout), MAX_TIMEOUT_SEC)
          : DEFAULT_TIMEOUT_SEC;

      // 1. 解析命令，提取子命令路径
      let tokens = tokenize(params.command ?? "");
      if (tokens[0]?.toLowerCase() === "kubectl") tokens = tokens.slice(1);
      const cmd = commandPathOf(tokens);

      const wl = loadWhitelist();
      const details = (extra: Record<string, unknown>) => ({
        command: params.command,
        subcommand: cmd.join(" "),
        whitelistFile: wl.path,
        durationMs: Date.now() - started,
        ...extra,
      });

      // 2. 白名单校验（默认拒绝）
      if (!wl.exists) {
        return {
          content: [{
            type: "text",
            text:
              `拒绝执行: 未找到白名单文件 ${wl.path}。\n` +
              "请创建该文件（每行一个允许的 kubectl 子命令，# 为注释），在此之前所有 kubectl 命令均被拒绝。",
          }],
          details: details({ allowed: false, reason: "whitelist-file-missing" }),
          isError: true,
        };
      }
      if (tokens.length === 0 || cmd.length === 0) {
        return {
          content: [{
            type: "text",
            text:
              `拒绝执行: 无法从 "${params.command}" 中解析出子命令（或子命令前出现了 flag）。\n` +
              "全局 flag（如 -n/--context）请放在子命令之后，例如 'get pods -n kube-system'。",
          }],
          details: details({ allowed: false, reason: "no-subcommand" }),
          isError: true,
        };
      }
      if (!isAllowed(cmd, wl.entries)) {
        const allowed = wl.entries.length > 0
          ? wl.entries.map((e) => e.join(" ")).join(", ")
          : "（白名单为空）";
        return {
          content: [{
            type: "text",
            text:
              `拒绝执行: 子命令 "${cmd.join(" ")}" 不在 kubectl 白名单中。\n` +
              `当前允许的子命令: ${allowed}\n` +
              `白名单文件: ${wl.path}（每行一个子命令，支持更具体的前缀条目如 'get pods'；修改后立即生效）。`,
          }],
          details: details({ allowed: false, reason: "not-in-whitelist" }),
          isError: true,
        };
      }

      // 3. 执行
      const run = await runKubectl(tokens, timeoutSec, ctx?.cwd, signal);

      if (run.aborted) {
        return {
          content: [{ type: "text", text: "执行已中止。" }],
          details: details({ allowed: true, aborted: true }),
          isError: true,
        };
      }
      if (run.notFound) {
        return {
          content: [{
            type: "text",
            text: "未找到 kubectl 可执行文件（PATH 中需要存在 kubectl / kubectl.exe），命令未执行。",
          }],
          details: details({ allowed: true, notFound: true }),
          isError: true,
        };
      }

      // 4. 组织输出
      let out = (run.stdout ?? "").trimEnd();
      if (run.timedOut) {
        out += `\n\n[执行超时: 超过 ${timeoutSec}s，进程已被终止。]`;
      }
      const errOut = (run.stderr ?? "").trim();
      if (errOut) {
        out += `\n\nSTDERR:\n${errOut}`;
      }
      const t = truncateOutput(out);
      let text = t.text;
      if (run.exitCode !== 0) {
        text = `kubectl 退出码: ${run.exitCode ?? "未知"}\n\n${text}`;
      }

      return {
        content: [{ type: "text", text }],
        details: details({
          allowed: true,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          truncated: t.truncated,
        }),
      };
    },
  });

  // ──────────────────────────────────────────────────────────
  // /kubectl — 查看当前白名单
  // ──────────────────────────────────────────────────────────
  pi.registerCommand("kubectl", {
    description: "查看 kubectl 工具的白名单配置",
    handler: async (_args: string, ctx: any) => {
      if (ctx?.mode !== "tui") return;
      const wl = loadWhitelist();
      const list = wl.entries.length > 0
        ? wl.entries.map((e) => e.join(" ")).join(", ")
        : "（空，所有 kubectl 子命令均被拒绝）";
      ctx.ui.notify(
        `kubectl 白名单 (${wl.path}):\n${list}\n规则: 前缀匹配，未列出的子命令默认拒绝；修改文件后立即生效。`,
        "info",
      );
    },
  });
}
