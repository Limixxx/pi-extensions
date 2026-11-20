// @ts-ignore
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
// @ts-ignore
import { execSync } from "node:child_process";

/** 直接执行 gh 命令 */
function ghExec(subcmd: string[], extra: string[] = []): string {
  const cmd = ["gh", ...subcmd, ...extra].map(a => `"${a}"`).join(" ");
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: 120_000,
      windowsHide: true,
    }).trim();
  } catch (e: any) {
    return `ERROR: ${e.stderr?.trim?.() ?? e.message}`;
  }
}

/** 构建通用 flag 数组 */
function buildFlags(opts: Record<string, unknown>): string[] {
  const flags: string[] = [];
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    if (typeof v === "boolean" && v) { flags.push(`--${k}`); continue; }
    if (Array.isArray(v)) {
      if (v.length > 0) flags.push(`--${k}`, v.join(","));
      continue;
    }
    flags.push(`--${k}`, String(v));
  }
  return flags;
}

// ============================================================
// 扩展入口
// ============================================================

export default function (pi: ExtensionAPI) {

  // ──────────────────────────────────────────────────────────
  // gh_auth — 认证管理
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_auth",
    label: "GitHub Auth",
    description: "管理 GitHub CLI 认证：查看状态(status)、获取token(token)、登出(logout)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: status | token | logout",
        enum: ["status", "token", "logout"],
      }),
      hostname: Type.Optional(Type.String({ description: "GitHub 主机名 (如 enterprise.internal)" })),
    }),
    async execute(_id: any, params: any) {
      const { subcommand, hostname } = params;
      const extra = buildFlags({ hostname });
      const result = ghExec(["auth", subcommand], extra);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_issue — Issue 操作
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_issue",
    label: "GitHub Issue",
    description: "GitHub Issue 管理：list(列出)、view(查看)、create(创建)、close(关闭)、reopen(重新打开)、edit(编辑)、comment(评论)、delete(删除)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: list | view | create | close | reopen | edit | comment | delete",
        enum: ["list", "view", "create", "close", "reopen", "edit", "comment", "delete"],
      }),
      number: Type.Optional(Type.Number({ description: "Issue 编号 (view/close/reopen/edit/comment/delete 时必填)" })),
      title: Type.Optional(Type.String({ description: "Issue 标题 (create/edit 时使用)" })),
      body: Type.Optional(Type.String({ description: "Issue 内容或评论内容" })),
      body_file: Type.Optional(Type.String({ description: "从文件读取 body" })),
      state: Type.Optional(Type.String({ description: "状态过滤: open | closed | all (list 时使用, 默认 open)", enum: ["open", "closed", "all"] })),
      limit: Type.Optional(Type.Number({ description: "返回数量限制 (默认 30)" })),
      assignee: Type.Optional(Type.String({ description: "按指派人过滤" })),
      labels: Type.Optional(Type.Array(Type.String(), { description: "标签列表" })),
      search: Type.Optional(Type.String({ description: "搜索关键词" })),
      add_labels: Type.Optional(Type.Array(Type.String(), { description: "添加标签 (edit 时使用)" })),
      remove_labels: Type.Optional(Type.Array(Type.String(), { description: "移除标签 (edit 时使用)" })),
      add_assignees: Type.Optional(Type.Array(Type.String(), { description: "添加指派人" })),
      remove_assignees: Type.Optional(Type.Array(Type.String(), { description: "移除指派人" })),
      repo: Type.Optional(Type.String({ description: "目标仓库 (owner/repo)" })),
      json_fields: Type.Optional(Type.Array(Type.String(), { description: "JSON 输出字段" })),
    }),
    async execute(_id: any, params: any) {
      const { subcommand } = params;
      const args: string[] = ["issue", subcommand];
      const flags: string[] = [];

      switch (subcommand) {
        case "list":
          flags.push(...buildFlags({
            state: params.state, limit: params.limit, assignee: params.assignee,
            "label": params.labels, search: params.search, repo: params.repo,
          }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "view":
          args.push(String(params.number));
          flags.push(...buildFlags({ repo: params.repo }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "create":
          flags.push(...buildFlags({
            title: params.title, body: params.body, "body-file": params.body_file,
            "label": params.labels, assignee: params.add_assignees, repo: params.repo,
          }));
          break;
        case "close":
        case "reopen":
          args.push(String(params.number));
          flags.push(...buildFlags({ comment: params.body, repo: params.repo }));
          break;
        case "edit":
          args.push(String(params.number));
          flags.push(...buildFlags({
            title: params.title, body: params.body, repo: params.repo,
            "add-label": params.add_labels, "remove-label": params.remove_labels,
            "add-assignee": params.add_assignees, "remove-assignee": params.remove_assignees,
          }));
          break;
        case "comment":
          args.push(String(params.number));
          flags.push(...buildFlags({ body: params.body, repo: params.repo }));
          break;
        case "delete":
          args.push(String(params.number), "--yes");
          flags.push(...buildFlags({ repo: params.repo }));
          break;
      }

      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_pr — Pull Request 操作
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_pr",
    label: "GitHub PR",
    description: "GitHub Pull Request 管理：list(列出)、view(查看)、create(创建)、merge(合并)、close(关闭)、reopen(重新打开)、checkout(检出)、diff(差异)、edit(编辑)、checks(检查)、review(审查)、comment(评论)、ready(标记就绪)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: list | view | create | merge | close | reopen | checkout | diff | edit | checks | review | comment | ready",
        enum: ["list", "view", "create", "merge", "close", "reopen", "checkout", "diff", "edit", "checks", "review", "comment", "ready"],
      }),
      number: Type.Optional(Type.Number({ description: "PR 编号" })),
      title: Type.Optional(Type.String({ description: "PR 标题" })),
      body: Type.Optional(Type.String({ description: "PR 内容或评论" })),
      body_file: Type.Optional(Type.String({ description: "从文件读取 body" })),
      head: Type.Optional(Type.String({ description: "HEAD 分支" })),
      base: Type.Optional(Type.String({ description: "BASE 分支" })),
      draft: Type.Optional(Type.Boolean({ description: "创建为 Draft PR" })),
      state: Type.Optional(Type.String({ description: "状态过滤: open | closed | merged | all", enum: ["open", "closed", "merged", "all"] })),
      limit: Type.Optional(Type.Number({ description: "返回数量限制" })),
      author: Type.Optional(Type.String({ description: "按作者过滤" })),
      labels: Type.Optional(Type.Array(Type.String(), { description: "标签列表" })),
      search: Type.Optional(Type.String({ description: "搜索关键词" })),
      method: Type.Optional(Type.String({ description: "合并方式: merge | squash | rebase", enum: ["merge", "squash", "rebase"] })),
      delete_branch: Type.Optional(Type.Boolean({ description: "合并后删除分支" })),
      add_labels: Type.Optional(Type.Array(Type.String(), { description: "添加标签" })),
      remove_labels: Type.Optional(Type.Array(Type.String(), { description: "移除标签" })),
      add_assignees: Type.Optional(Type.Array(Type.String(), { description: "添加指派人" })),
      add_reviewers: Type.Optional(Type.Array(Type.String(), { description: "添加审查人" })),
      approve: Type.Optional(Type.Boolean({ description: "批准 PR (review 时使用)" })),
      request_changes: Type.Optional(Type.Boolean({ description: "请求修改 (review 时使用)" })),
      repo: Type.Optional(Type.String({ description: "目标仓库 (owner/repo)" })),
      json_fields: Type.Optional(Type.Array(Type.String(), { description: "JSON 输出字段" })),
    }),
    async execute(_id: any, params: any) {
      const { subcommand } = params;
      const args: string[] = ["pr", subcommand];
      const flags: string[] = [];

      switch (subcommand) {
        case "list":
          flags.push(...buildFlags({
            state: params.state, limit: params.limit, head: params.head, base: params.base,
            author: params.author, "label": params.labels, search: params.search, repo: params.repo,
          }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "view":
          args.push(String(params.number));
          flags.push(...buildFlags({ repo: params.repo }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "create":
          flags.push(...buildFlags({
            title: params.title, body: params.body, "body-file": params.body_file,
            head: params.head, base: params.base, draft: params.draft,
            labels: params.labels, assignee: params.add_assignees,
            reviewer: params.add_reviewers, repo: params.repo,
          }));
          break;
        case "merge":
          args.push(String(params.number));
          flags.push(...buildFlags({
            [params.method ?? "merge"]: true, "delete-branch": params.delete_branch, repo: params.repo,
          }));
          break;
        case "close":
        case "reopen":
          args.push(String(params.number));
          flags.push(...buildFlags({ comment: params.body, repo: params.repo }));
          break;
        case "checkout":
        case "diff":
        case "ready":
          args.push(String(params.number));
          flags.push(...buildFlags({ repo: params.repo }));
          break;
        case "edit":
          args.push(String(params.number));
          flags.push(...buildFlags({
            title: params.title, body: params.body, repo: params.repo,
            "add-label": params.add_labels, "remove-label": params.remove_labels,
            "add-assignee": params.add_assignees, "add-reviewer": params.add_reviewers,
            ready: params.draft === false,
          }));
          break;
        case "checks":
          args.push(String(params.number));
          flags.push(...buildFlags({ repo: params.repo }));
          break;
        case "review":
          args.push(String(params.number));
          flags.push(...buildFlags({
            approve: params.approve, "request-changes": params.request_changes,
            body: params.body, repo: params.repo,
          }));
          break;
        case "comment":
          args.push(String(params.number));
          flags.push(...buildFlags({ body: params.body, repo: params.repo }));
          break;
      }

      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_repo — 仓库操作
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_repo",
    label: "GitHub Repo",
    description: "GitHub 仓库管理：list(列出)、view(查看)、create(创建)、clone(克隆)、fork(派生)、delete(删除)、edit(编辑)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: list | view | create | clone | fork | delete | edit",
        enum: ["list", "view", "create", "clone", "fork", "delete", "edit"],
      }),
      name: Type.Optional(Type.String({ description: "仓库名称 (owner/repo 或 repo)" })),
      description: Type.Optional(Type.String({ description: "仓库描述 (create/edit 时使用)" })),
      visibility: Type.Optional(Type.String({ description: "可见性: public | private (create 时使用)", enum: ["public", "private"] })),
      homepage: Type.Optional(Type.String({ description: "主页 URL" })),
      default_branch: Type.Optional(Type.String({ description: "默认分支" })),
      directory: Type.Optional(Type.String({ description: "克隆目标目录 (clone 时使用)" })),
      clone: Type.Optional(Type.Boolean({ description: "Fork 后克隆 (fork 时使用)" })),
      org: Type.Optional(Type.String({ description: "Fork 到的组织" })),
      limit: Type.Optional(Type.Number({ description: "返回数量限制" })),
      repo: Type.Optional(Type.String({ description: "目标仓库 (owner/repo)" })),
      json_fields: Type.Optional(Type.Array(Type.String(), { description: "JSON 输出字段" })),
    }),
    async execute(_id: any, params: any) {
      const { subcommand } = params;
      const args: string[] = ["repo", subcommand];
      const flags: string[] = [];

      switch (subcommand) {
        case "list":
          if (params.name) args.push(params.name);
          flags.push(...buildFlags({ limit: params.limit, repo: params.repo }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "view":
          if (params.name) args.push(params.name);
          flags.push(...buildFlags({ repo: params.repo }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "create":
          if (params.name) args.push(params.name);
          flags.push(...buildFlags({
            [params.visibility ?? "private"]: true, description: params.description,
            clone: params.clone, repo: params.repo,
          }));
          break;
        case "clone":
          if (params.name) args.push(params.name);
          if (params.directory) args.push(params.directory);
          break;
        case "fork":
          if (params.name) args.push(params.name);
          flags.push(...buildFlags({ clone: params.clone, org: params.org }));
          break;
        case "delete":
          if (params.name) args.push(params.name, "--yes");
          break;
        case "edit":
          flags.push(...buildFlags({
            description: params.description, homepage: params.homepage,
            "default-branch": params.default_branch, repo: params.repo,
          }));
          break;
      }

      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_actions — Actions / Workflow 操作
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_actions",
    label: "GitHub Actions",
    description: "GitHub Actions 管理：run_list(列出运行)、run_view(查看运行)、run_watch(监视运行)、run_rerun(重运行)、run_cancel(取消运行)、run_download(下载产物)、workflow_list(列出工作流)、workflow_run(触发工作流)、workflow_enable(启用)、workflow_disable(禁用)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: run_list | run_view | run_watch | run_rerun | run_cancel | run_download | workflow_list | workflow_run | workflow_enable | workflow_disable",
        enum: ["run_list", "run_view", "run_watch", "run_rerun", "run_cancel", "run_download", "workflow_list", "workflow_run", "workflow_enable", "workflow_disable"],
      }),
      run_id: Type.Optional(Type.String({ description: "Run ID (run_view/watch/rerun/cancel/download 时使用)" })),
      workflow: Type.Optional(Type.String({ description: "工作流名称或 ID (workflow_run/enable/disable 时使用)" })),
      ref: Type.Optional(Type.String({ description: "触发分支 (workflow_run 时使用)" })),
      raw_fields: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "工作流输入参数 (workflow_run 时使用)" })),
      branch: Type.Optional(Type.String({ description: "按分支过滤 (run_list 时使用)" })),
      limit: Type.Optional(Type.Number({ description: "返回数量限制" })),
      name: Type.Optional(Type.String({ description: "下载指定产物名称 (run_download 时使用)" })),
      dir: Type.Optional(Type.String({ description: "下载目标目录 (run_download 时使用)" })),
      repo: Type.Optional(Type.String({ description: "目标仓库 (owner/repo)" })),
      json_fields: Type.Optional(Type.Array(Type.String(), { description: "JSON 输出字段" })),
    }),
    async execute(_id: any, params: any) {
      const { subcommand } = params;
      const isRun = subcommand.startsWith("run_");
      const action = isRun ? subcommand.slice(4) : subcommand.slice(9);
      const group = isRun ? "run" : "workflow";
      const args: string[] = [group, action];
      const flags: string[] = [];

      switch (subcommand) {
        case "run_list":
          flags.push(...buildFlags({ workflow: params.workflow, branch: params.branch, limit: params.limit, repo: params.repo }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "run_view":
          args.push(String(params.run_id));
          flags.push(...buildFlags({ repo: params.repo }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "run_watch":
          args.push(String(params.run_id));
          flags.push(...buildFlags({ repo: params.repo }));
          break;
        case "run_rerun":
        case "run_cancel":
          args.push(String(params.run_id));
          flags.push(...buildFlags({ repo: params.repo }));
          break;
        case "run_download":
          args.push(String(params.run_id));
          flags.push(...buildFlags({ name: params.name, dir: params.dir, repo: params.repo }));
          break;
        case "workflow_list":
          flags.push(...buildFlags({ repo: params.repo }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "workflow_run":
          if (params.workflow) args.push(params.workflow);
          flags.push(...buildFlags({ ref: params.ref, repo: params.repo }));
          if (params.raw_fields) {
            for (const [k, v] of Object.entries(params.raw_fields)) {
              flags.push("--raw-field", `${k}=${v}`);
            }
          }
          break;
        case "workflow_enable":
        case "workflow_disable":
          if (params.workflow) args.push(params.workflow);
          flags.push(...buildFlags({ repo: params.repo }));
          break;
      }

      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_release — Release 操作
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_release",
    label: "GitHub Release",
    description: "GitHub Release 管理：list(列出)、view(查看)、create(创建)、delete(删除)、upload(上传)、download(下载)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: list | view | create | delete | upload | download",
        enum: ["list", "view", "create", "delete", "upload", "download"],
      }),
      tag: Type.Optional(Type.String({ description: "Release 标签 (view/create/delete/upload/download 时使用)" })),
      notes: Type.Optional(Type.String({ description: "Release 说明 (create 时使用)" })),
      notes_file: Type.Optional(Type.String({ description: "从文件读取 Release 说明" })),
      target: Type.Optional(Type.String({ description: "目标分支或提交 (create 时使用)" })),
      title: Type.Optional(Type.String({ description: "Release 标题" })),
      draft: Type.Optional(Type.Boolean({ description: "创建为草稿" })),
      prerelease: Type.Optional(Type.Boolean({ description: "创建为预发布" })),
      files: Type.Optional(Type.Array(Type.String(), { description: "上传文件路径列表" })),
      pattern: Type.Optional(Type.String({ description: "下载文件匹配模式" })),
      dir: Type.Optional(Type.String({ description: "下载目标目录" })),
      limit: Type.Optional(Type.Number({ description: "返回数量限制" })),
      repo: Type.Optional(Type.String({ description: "目标仓库 (owner/repo)" })),
      json_fields: Type.Optional(Type.Array(Type.String(), { description: "JSON 输出字段" })),
    }),
    async execute(_id: any, params: any) {
      const { subcommand } = params;
      const args: string[] = ["release", subcommand];
      const flags: string[] = [];

      switch (subcommand) {
        case "list":
          flags.push(...buildFlags({ limit: params.limit, repo: params.repo }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "view":
          if (params.tag) args.push(params.tag);
          flags.push(...buildFlags({ repo: params.repo }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "create":
          if (params.tag) args.push(params.tag);
          flags.push(...buildFlags({
            notes: params.notes, "notes-file": params.notes_file, target: params.target,
            title: params.title, draft: params.draft, prerelease: params.prerelease, repo: params.repo,
          }));
          break;
        case "delete":
          if (params.tag) args.push(params.tag, "--yes");
          flags.push(...buildFlags({ repo: params.repo }));
          break;
        case "upload":
          if (params.tag) args.push(params.tag);
          if (params.files) args.push(...params.files);
          flags.push(...buildFlags({ repo: params.repo }));
          break;
        case "download":
          if (params.tag) args.push(params.tag);
          flags.push(...buildFlags({ pattern: params.pattern, dir: params.dir, repo: params.repo }));
          break;
      }

      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_api — 直接 API 调用
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_api",
    label: "GitHub API",
    description: "直接调用 GitHub REST/GraphQL API。如 /user、/repos/owner/repo/issues 等。支持 --paginate 和 --jq 过滤。",
    parameters: Type.Object({
      endpoint: Type.String({ description: "API 端点，如 /user, /repos/owner/repo/issues" }),
      method: Type.Optional(Type.String({ description: "HTTP 方法: GET | POST | PUT | PATCH | DELETE", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] })),
      field: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "--field 键值对 (如 {title: 'Bug'})" })),
      header: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "--header 键值对" })),
      paginate: Type.Optional(Type.Boolean({ description: "是否启用分页获取全部结果" })),
      jq: Type.Optional(Type.String({ description: "jq 过滤表达式" })),
      repo: Type.Optional(Type.String({ description: "目标仓库 (owner/repo)" })),
    }),
    async execute(_id: any, params: any) {
      const args: string[] = ["api", params.endpoint];
      const flags: string[] = [];
      flags.push(...buildFlags({ method: params.method, repo: params.repo, paginate: params.paginate, jq: params.jq }));
      if (params.field) {
        for (const [k, v] of Object.entries(params.field)) {
          flags.push("--field", `${k}=${v}`);
        }
      }
      if (params.header) {
        for (const [k, v] of Object.entries(params.header)) {
          flags.push("--header", `${k}: ${v}`);
        }
      }
      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_search — 搜索
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_search",
    label: "GitHub Search",
    description: "在 GitHub 上搜索：code(代码)、issues(Issue)、prs(PR)、repos(仓库)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: code | issues | prs | repos",
        enum: ["code", "issues", "prs", "repos"],
      }),
      query: Type.String({ description: "搜索关键词" }),
      repo: Type.Optional(Type.String({ description: "限定仓库 (code 搜索时使用)" })),
      limit: Type.Optional(Type.Number({ description: "返回数量限制" })),
      json_fields: Type.Optional(Type.Array(Type.String(), { description: "JSON 输出字段" })),
    }),
    async execute(_id: any, params: any) {
      const args: string[] = ["search", params.subcommand, params.query];
      const flags = buildFlags({ limit: params.limit, repo: params.repo });
      if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_secret — Secrets 管理
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_secret",
    label: "GitHub Secrets",
    description: "管理 GitHub Actions Secrets：list(列出)、set(设置)、delete(删除)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: list | set | delete",
        enum: ["list", "set", "delete"],
      }),
      name: Type.Optional(Type.String({ description: "Secret 名称 (set/delete 时使用)" })),
      body: Type.Optional(Type.String({ description: "Secret 值 (set 时使用)" })),
      env: Type.Optional(Type.String({ description: "目标环境名称" })),
      repo: Type.Optional(Type.String({ description: "目标仓库 (owner/repo)" })),
    }),
    async execute(_id: any, params: any) {
      const args: string[] = ["secret", params.subcommand];
      const flags = buildFlags({ body: params.body, env: params.env, repo: params.repo });
      if (params.name && (params.subcommand === "set" || params.subcommand === "delete")) {
        args.push(params.name);
      }
      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_variable — Variables 管理
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_variable",
    label: "GitHub Variables",
    description: "管理 GitHub Actions Variables：list(列出)、set(设置)、get(获取)、delete(删除)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: list | set | get | delete",
        enum: ["list", "set", "get", "delete"],
      }),
      name: Type.Optional(Type.String({ description: "Variable 名称 (set/get/delete 时使用)" })),
      body: Type.Optional(Type.String({ description: "Variable 值 (set 时使用)" })),
      env: Type.Optional(Type.String({ description: "目标环境名称" })),
      repo: Type.Optional(Type.String({ description: "目标仓库 (owner/repo)" })),
    }),
    async execute(_id: any, params: any) {
      const args: string[] = ["variable", params.subcommand];
      const flags = buildFlags({ body: params.body, env: params.env, repo: params.repo });
      if (params.name && params.subcommand !== "list") {
        args.push(params.name);
      }
      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_label — Label 操作
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_label",
    label: "GitHub Labels",
    description: "管理 GitHub Labels：list(列出)、create(创建)、delete(删除)、clone(从仓库克隆)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: list | create | delete | clone",
        enum: ["list", "create", "delete", "clone"],
      }),
      name: Type.Optional(Type.String({ description: "Label 名称 (create/delete 时使用)" })),
      color: Type.Optional(Type.String({ description: "Label 颜色 (如 ff0000, create 时使用)" })),
      description: Type.Optional(Type.String({ description: "Label 描述" })),
      source_repo: Type.Optional(Type.String({ description: "源仓库 (clone 时使用, owner/repo)" })),
      repo: Type.Optional(Type.String({ description: "目标仓库 (owner/repo)" })),
    }),
    async execute(_id: any, params: any) {
      const args: string[] = ["label", params.subcommand];
      const flags = buildFlags({ color: params.color, description: params.description, repo: params.repo });

      switch (params.subcommand) {
        case "create":
          if (params.name) args.push(params.name);
          break;
        case "delete":
          if (params.name) args.push(params.name, "--yes");
          break;
        case "clone":
          if (params.source_repo) args.push(params.source_repo);
          break;
      }

      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_gist — Gist 操作
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_gist",
    label: "GitHub Gist",
    description: "管理 GitHub Gists：list(列出)、create(创建)、view(查看)、delete(删除)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: list | create | view | delete",
        enum: ["list", "create", "view", "delete"],
      }),
      gist_id: Type.Optional(Type.String({ description: "Gist ID (view/delete 时使用)" })),
      files: Type.Optional(Type.Array(Type.String(), { description: "文件路径列表 (create 时使用)" })),
      desc: Type.Optional(Type.String({ description: "Gist 描述 (create 时使用)" })),
      public: Type.Optional(Type.Boolean({ description: "是否公开 (create 时使用)" })),
      limit: Type.Optional(Type.Number({ description: "返回数量限制 (list 时使用)" })),
    }),
    async execute(_id: any, params: any) {
      const args: string[] = ["gist", params.subcommand];
      const flags = buildFlags({ desc: params.desc, public: params.public, limit: params.limit });

      switch (params.subcommand) {
        case "create":
          if (params.files) args.push(...params.files);
          break;
        case "view":
        case "delete":
          if (params.gist_id) args.push(params.gist_id);
          if (params.subcommand === "delete") args.push("--yes");
          break;
      }

      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_config — 配置与状态
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_config",
    label: "GitHub Config & Status",
    description: "查看 GitHub 状态概览、管理 gh 配置、在浏览器中打开页面。subcommand: status | browse | config_get | config_set | config_list。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: status | browse | config_get | config_set | config_list",
        enum: ["status", "browse", "config_get", "config_set", "config_list"],
      }),
      target: Type.Optional(Type.String({ description: "browse 目标路径或 issue/PR 编号" })),
      key: Type.Optional(Type.String({ description: "配置键 (config_get/config_set 时使用)" })),
      value: Type.Optional(Type.String({ description: "配置值 (config_set 时使用)" })),
      repo: Type.Optional(Type.String({ description: "目标仓库 (owner/repo)" })),
    }),
    async execute(_id: any, params: any) {
      const { subcommand } = params;
      let result: string;

      switch (subcommand) {
        case "status":
          result = ghExec(["status"], buildFlags({ repo: params.repo }));
          break;
        case "browse":
          result = ghExec(["browse", ...(params.target ? [params.target] : [])], buildFlags({ repo: params.repo }));
          break;
        case "config_get":
          result = ghExec(["config", "get", params.key ?? ""]);
          break;
        case "config_set":
          result = ghExec(["config", "set", params.key ?? "", params.value ?? ""]);
          break;
        case "config_list":
          result = ghExec(["config", "list"]);
          break;
        default:
          result = `Unknown subcommand: ${subcommand}`;
      }

      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_key — SSH / GPG Key 管理
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_key",
    label: "GitHub Keys",
    description: "管理 GitHub SSH Keys 和 GPG Keys：ssh_list | ssh_add | ssh_delete | gpg_list | gpg_add | gpg_delete。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: ssh_list | ssh_add | ssh_delete | gpg_list | gpg_add | gpg_delete",
        enum: ["ssh_list", "ssh_add", "ssh_delete", "gpg_list", "gpg_add", "gpg_delete"],
      }),
      file: Type.Optional(Type.String({ description: "公钥文件路径 (ssh_add/gpg_add 时使用)" })),
      key_id: Type.Optional(Type.String({ description: "Key ID (ssh_delete/gpg_delete 时使用)" })),
      title: Type.Optional(Type.String({ description: "Key 标题 (ssh_add 时使用)" })),
    }),
    async execute(_id: any, params: any) {
      const { subcommand } = params;
      const isSsh = subcommand.startsWith("ssh_");
      const group = isSsh ? "ssh-key" : "gpg-key";
      const action = subcommand.split("_")[1];
      const args: string[] = [group, action];
      const flags = buildFlags({ title: params.title });

      switch (action) {
        case "add":
          if (params.file) args.push(params.file);
          break;
        case "delete":
          if (params.key_id) args.push(params.key_id, "--yes");
          break;
      }

      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ──────────────────────────────────────────────────────────
  // gh_project — Project 操作
  // ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_project",
    label: "GitHub Projects",
    description: "管理 GitHub Projects：item_list(列出项目项)、item_edit(编辑项目项字段)。",
    parameters: Type.Object({
      subcommand: Type.String({
        description: "子命令: item_list | item_edit",
        enum: ["item_list", "item_edit"],
      }),
      project_number: Type.Optional(Type.Number({ description: "项目编号" })),
      item_id: Type.Optional(Type.String({ description: "项目项 ID (item_edit 时使用)" })),
      project_id: Type.Optional(Type.String({ description: "项目 ID (item_edit 时使用)" })),
      field_id: Type.Optional(Type.String({ description: "字段 ID (item_edit 时使用)" })),
      option_id: Type.Optional(Type.String({ description: "选项 ID (item_edit 时使用)" })),
      limit: Type.Optional(Type.Number({ description: "返回数量限制" })),
      json_fields: Type.Optional(Type.Array(Type.String(), { description: "JSON 输出字段" })),
    }),
    async execute(_id: any, params: any) {
      const { subcommand } = params;
      const args: string[] = ["project", subcommand];
      const flags: string[] = [];

      switch (subcommand) {
        case "item_list":
          if (params.project_number) args.push(String(params.project_number));
          flags.push(...buildFlags({ limit: params.limit }));
          if (params.json_fields?.length) flags.push("--json", params.json_fields.join(","));
          break;
        case "item_edit":
          flags.push(...buildFlags({
            id: params.item_id, "project-id": params.project_id,
            "field-id": params.field_id, "single-select-option-id": params.option_id,
          }));
          break;
      }

      const result = ghExec(args, flags);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });
}
