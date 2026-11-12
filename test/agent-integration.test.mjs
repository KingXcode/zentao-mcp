import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { getAgentTargets, parseAgentConfig } from "../lib/agent-config.mjs";
import { applyAgentChange, ensureProjectEnv, planAgentChange } from "../lib/agent-manager.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const execFile = promisify(execFileCallback);

test("CLI help and dry-run need no Agent CLI and never write target configs", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "zentao-cli-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = path.join(projectRoot, "scripts", "manage-agents.mjs");
  const help = await execFile(process.execPath, [script, "--help"]);
  assert.match(help.stdout, /打开本地网页/);
  const preview = await execFile(process.execPath, [script, "install", "--agent", "all", "--home", home, "--dry-run"]);
  assert.match(preview.stdout, /\[预览\].*将安装/);
  assert.doesNotMatch(preview.stdout, /正在安装项目依赖/);
  assert.deepEqual(await readdir(home), []);
  await assert.rejects(execFile(process.execPath, [script, "install", "--agent", "unknown", "--home", home]), (error) => {
    assert.match(error.stderr, /未知 Agent/);
    return true;
  });
  assert.deepEqual(await readdir(home), []);
});

test("an installed entry launches the real MCP and lists all tools from any working directory", { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "zentao-mcp-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDirectory = path.join(root, "project with space");
  await mkdir(projectDirectory);
  await cp(path.join(projectRoot, "lib"), path.join(projectDirectory, "lib"), { recursive: true });
  await cp(path.join(projectRoot, "server.mjs"), path.join(projectDirectory, "server.mjs"));
  await symlink(path.join(projectRoot, "node_modules"), path.join(projectDirectory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(projectDirectory, ".env.example"), "ZENTAO_BASE_URL=http://127.0.0.1:1\nZENTAO_TOKEN=\n");
  await ensureProjectEnv(projectDirectory);
  const target = getAgentTargets({ home: root, env: {} }).find((target) => target.id === "codex");
  await applyAgentChange(await planAgentChange(target, { projectDirectory, action: "install" }));
  const config = parseAgentConfig(await readFile(target.configPath, "utf8"), target).mcp_servers.zentao;
  const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: root });
  const client = new Client({ name: "zentao-installer-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_bug_detail", "get_bug_image", "get_execution_tasks", "get_product_bugs", "list_project_bugs", "list_projects", "list_products"].sort());
  await client.close();
});
