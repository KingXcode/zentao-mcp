#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const help = `禅道 MCP 安装工具（Node.js 20+）

  npm run mcp:manage                         打开本地网页
  npm run mcp:manage -- --no-open             仅启动网页服务
  npm run mcp:manage -- install --agent all   安装到全部 Agent
  npm run mcp:manage -- uninstall --agent codex,cursor
  npm run mcp:manage -- status                查看注册状态

选项：
  --agent, -a   Agent ID，支持逗号分隔、多次指定或 all
  --dry-run     预览安装 / 卸载，不修改 Agent 配置或 .env
  --home        指定配置主目录，忽略各应用的配置目录环境变量
  --config      指定单个 Agent 的配置文件（需同时指定一个 --agent）
  --port        网页端口，默认自动分配
  --no-open     不自动打开浏览器
  --help, -h    显示帮助
`;

export async function ensureDependencies(directory, output = process.stdout) {
  const require = createRequire(path.join(directory, "package.json"));
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const missing = Object.keys(manifest.dependencies || {}).filter((name) => {
    try { require.resolve(name === "@modelcontextprotocol/sdk" ? `${name}/server/mcp.js` : name); return false; } catch { return true; }
  });
  if (!missing.length) return;
  output.write("首次使用，正在安装项目依赖…\n");
  await new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(windows ? (process.env.ComSpec || "cmd.exe") : "npm", windows
      ? ["/d", "/s", "/c", "npm ci --omit=dev"] : ["ci", "--omit=dev"], { cwd: directory, stdio: "inherit" });
    child.once("error", () => reject(new Error("无法启动 npm，请先安装 Node.js 20 或更新版本")));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("依赖安装失败，请检查 npm 网络连接后重试")));
  });
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "darwin") { command = "/usr/bin/open"; args = [url]; }
  else if (process.platform === "win32") { command = "rundll32.exe"; args = ["url.dll,FileProtocolHandler", url]; }
  else { command = "xdg-open"; args = [url]; }
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => process.stdout.write("无法自动打开浏览器，请手动访问上面的地址。\n"));
  child.unref();
}

export async function runManager(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    agent: { type: "string", multiple: true, short: "a" },
    "dry-run": { type: "boolean", default: false },
    home: { type: "string" }, config: { type: "string" }, port: { type: "string" },
    "no-open": { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { process.stdout.write(help); return 0; }
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("请使用 Node.js 20 或更新版本");
  const action = positionals[0] || "ui";
  if (positionals.length > 1 || !["ui", "status", "install", "uninstall"].includes(action)) throw new Error("未知命令，请运行 --help 查看用法");
  if (values["dry-run"] && !["install", "uninstall"].includes(action)) throw new Error("--dry-run 仅用于 install / uninstall");
  const port = Number(values.port || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("端口必须是 0 到 65535 的整数");
  await ensureDependencies(projectDirectory);
  const { getAgentTargets } = await import("../lib/agent-config.mjs");
  const { applyAgentChange, ensureProjectEnv, getAgentStatus, planAgentChange } = await import("../lib/agent-manager.mjs");
  let targets = getAgentTargets(values.home ? { home: path.resolve(values.home), env: {} } : {});
  const ids = [...new Set((values.agent || []).flatMap((value) => value.split(",").map((id) => id.trim())))];
  if (ids.length && !(ids.length === 1 && ids[0] === "all")) {
    if (ids.some((id) => !targets.some((target) => target.id === id))) throw new Error(`未知 Agent；可选：${targets.map((target) => target.id).join(", ")}`);
    targets = targets.filter((target) => ids.includes(target.id));
  }
  if (values.config) {
    if (targets.length !== 1) throw new Error("--config 需要且只能指定一个 Agent");
    targets[0].configPath = path.resolve(values.config);
  }
  if (action === "ui") {
    const { createManagementServer } = await import("../lib/agent-web.mjs");
    const app = createManagementServer({ projectDirectory, targets });
    const url = await app.listen(port);
    process.stdout.write(`禅道 MCP 安装工具已启动：${url}\n保持此窗口打开；在网页点击「关闭工具」或在此按 Ctrl+C 结束。\n`);
    if (!values["no-open"]) openBrowser(url);
    return 0;
  }
  if (action === "status") {
    let failed = false;
    for (const target of targets) {
      try {
        const { state } = await getAgentStatus(target, projectDirectory);
        process.stdout.write(`${target.label} (${target.id})：${{ absent: "未安装", installed: "已注册本项目", conflict: "同名项属于其他项目" }[state]}\n  ${target.configPath}\n`);
      } catch (error) { failed = true; process.stderr.write(`${error.message}\n`); }
    }
    return failed ? 1 : 0;
  }
  if (!ids.length) throw new Error("请使用 --agent 指定目标，或不带命令打开网页选择");
  const plans = await Promise.all(targets.map((target) => planAgentChange(target, { projectDirectory, action })));
  if (action === "install" && !values["dry-run"]) await ensureProjectEnv(projectDirectory);
  for (const plan of plans) {
    const result = values["dry-run"] ? plan : await applyAgentChange(plan);
    const verb = values["dry-run"] ? (action === "install" ? "将安装" : "将卸载") : (action === "install" ? "已安装" : "已卸载");
    process.stdout.write(`${values["dry-run"] ? "[预览] " : ""}${plan.target.label}：${result.changed ? verb : "无需修改"}\n  ${plan.target.configPath}\n`);
    if (result.backupPath) process.stdout.write(`  备份：${result.backupPath}\n`);
  }
  if (!values["dry-run"]) process.stdout.write("重新启动对应 Agent 后生效。\n");
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runManager().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`操作失败：${error.code ? error.code : error.message}\n`);
    process.exitCode = 1;
  });
}
