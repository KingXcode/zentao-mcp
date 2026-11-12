import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getAgentTargets, parseAgentConfig } from "../lib/agent-config.mjs";
import { applyAgentChange, ensureProjectEnv, getAgentStatus, planAgentChange } from "../lib/agent-manager.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "zentao manager 测试-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDirectory = path.join(root, "project space");
  await mkdir(projectDirectory);
  await writeFile(path.join(projectDirectory, ".env.example"), "ZENTAO_BASE_URL=https://example.com\n");
  const target = getAgentTargets({ home: root, env: {} }).find((target) => target.id === "cursor");
  return { root, projectDirectory, target };
}

test("environment setup creates a private file once and preserves existing credentials", async (t) => {
  const { projectDirectory } = await fixture(t);
  assert.equal(await ensureProjectEnv(projectDirectory), true);
  if (process.platform !== "win32") assert.equal((await stat(path.join(projectDirectory, ".env"))).mode & 0o777, 0o600);
  await writeFile(path.join(projectDirectory, ".env"), "ZENTAO_PASSWORD=existing-fixture\n");
  assert.equal(await ensureProjectEnv(projectDirectory), false);
  assert.equal(await readFile(path.join(projectDirectory, ".env"), "utf8"), "ZENTAO_PASSWORD=existing-fixture\n");
});

test("install and uninstall create exact backups and keep all unrelated configuration", async (t) => {
  const { projectDirectory, target } = await fixture(t);
  await mkdir(path.dirname(target.configPath), { recursive: true });
  const original = '{"theme":"dark","mcpServers":{"other":{"command":"other"}}}\n';
  await writeFile(target.configPath, original);
  const installed = await applyAgentChange(await planAgentChange(target, { projectDirectory, action: "install" }));
  assert.equal(await readFile(installed.backupPath, "utf8"), original);
  if (process.platform !== "win32") assert.equal((await stat(installed.backupPath)).mode & 0o777, 0o600);
  const installedSource = await readFile(target.configPath, "utf8");
  const again = await applyAgentChange(await planAgentChange(target, { projectDirectory, action: "install" }));
  assert.equal(again.changed, false);
  assert.equal(again.backupPath, null);
  const removed = await applyAgentChange(await planAgentChange(target, { projectDirectory, action: "uninstall" }));
  assert.equal(await readFile(removed.backupPath, "utf8"), installedSource);
  assert.deepEqual(parseAgentConfig(await readFile(target.configPath, "utf8"), target), parseAgentConfig(original, target));
  assert.equal((await getAgentStatus(target, projectDirectory)).state, "absent");
});

test("planning changes and uninstalling an absent registration do not create directories", async (t) => {
  const { root, projectDirectory, target } = await fixture(t);
  const before = await readdir(root);
  const preview = await planAgentChange(target, { projectDirectory, action: "install" });
  assert.equal(preview.changed, true);
  assert.deepEqual(await readdir(root), before);
  await applyAgentChange(await planAgentChange(target, { projectDirectory, action: "uninstall" }));
  assert.deepEqual(await readdir(root), before);
});

test("a concurrent editor change is preserved and locks are cleaned up", async (t) => {
  const { projectDirectory, target } = await fixture(t);
  await mkdir(path.dirname(target.configPath), { recursive: true });
  await writeFile(target.configPath, "{}\n");
  const plan = await planAgentChange(target, { projectDirectory, action: "install" });
  const external = '{"savedByAnotherProgram":true}\n';
  await writeFile(target.configPath, external);
  await assert.rejects(applyAgentChange(plan), /其他程序修改/);
  assert.equal(await readFile(target.configPath, "utf8"), external);
  assert.deepEqual(await readdir(path.dirname(target.configPath)), ["mcp.json"]);
});

test("failed writes preserve the original file and a recoverable backup", async (t) => {
  const { projectDirectory, target } = await fixture(t);
  await mkdir(path.dirname(target.configPath), { recursive: true });
  await writeFile(target.configPath, "{}\n");
  const plan = await planAgentChange(target, { projectDirectory, action: "install" });
  await assert.rejects(applyAgentChange(plan, { writeConfig: async () => { throw new Error("injected failure"); } }), /injected failure/);
  assert.equal(await readFile(target.configPath, "utf8"), "{}\n");
  const files = await readdir(path.dirname(target.configPath));
  assert.equal(files.filter((name) => name.endsWith(".bak")).length, 1);
  assert.equal(files.filter((name) => name.endsWith(".lock")).length, 0);
});

test("symlinked dotfiles remain symlinks and dangling links are refused", { skip: process.platform === "win32" }, async (t) => {
  const { root, projectDirectory, target } = await fixture(t);
  await mkdir(path.dirname(target.configPath), { recursive: true });
  const realFile = path.join(root, "dotfile.json");
  await writeFile(realFile, "{}\n");
  await symlink(realFile, target.configPath);
  await applyAgentChange(await planAgentChange(target, { projectDirectory, action: "install" }));
  assert.equal((await lstat(target.configPath)).isSymbolicLink(), true);
  assert.ok(parseAgentConfig(await readFile(realFile, "utf8"), target).mcpServers.zentao);
  await rm(realFile);
  await assert.rejects(planAgentChange(target, { projectDirectory, action: "install" }), /无法读取配置/);
});
