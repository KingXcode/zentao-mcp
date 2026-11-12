import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getAgentTargets } from "../lib/agent-config.mjs";
import { createManagementServer, getProjectSettings } from "../lib/agent-web.mjs";
import { loadRuntimeConfig } from "../lib/runtime-config.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "zentao-web-test-"));
  const projectDirectory = path.join(root, "project");
  await mkdir(projectDirectory);
  await writeFile(path.join(projectDirectory, ".env.example"), "ZENTAO_BASE_URL=https://example.com\nZENTAO_ACCOUNT=\nZENTAO_PASSWORD=\nZENTAO_TOKEN=\n");
  const targets = getAgentTargets({ home: root, env: {} });
  const app = createManagementServer({ projectDirectory, targets });
  const url = await app.listen();
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const page = await fetch(url).then((response) => response.text());
  const token = page.match(/name="zentao-session" content="([a-f0-9]+)"/)[1];
  const request = (endpoint, body, headers = {}) => fetch(`${url}/api/${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Zentao-Token": token, ...(body === undefined ? {} : { Origin: url, "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { root, projectDirectory, targets, app, url, page, token, request };
}

test("the local UI serves assets and denies foreign origins, hostnames and missing session tokens", async (t) => {
  const { url, page, request } = await fixture(t);
  assert.match(page, /连接你的 Agent/);
  assert.doesNotMatch(page, /__SESSION_TOKEN__/);
  for (const asset of ["app.js", "style.css"]) assert.equal((await fetch(`${url}/${asset}`)).status, 200);
  assert.equal((await fetch(`${url}/api/state`)).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { Host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await request("state", undefined, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await request("change", { action: "install", agents: ["codex"] }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await request("change", { action: "install", agents: ["codex"] }, { "Content-Type": "text/plain" })).status, 403);
  assert.equal((await fetch(`${url}/../package.json`)).status, 404);
});

test("all agents can be installed, listed and uninstalled through the same API", async (t) => {
  const { projectDirectory, targets, request } = await fixture(t);
  let response = await request("change", { action: "install", agents: targets.map((target) => target.id) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).results.filter((result) => result.changed).length, targets.length);
  let state = await request("state").then((response) => response.json());
  assert.equal(state.agents.filter((agent) => agent.state === "installed").length, targets.length);
  assert.equal(state.settings.exists, true);
  response = await request("change", { action: "install", agents: targets.map((target) => target.id) });
  assert.equal((await response.json()).results.filter((result) => result.changed).length, 0);
  response = await request("change", { action: "uninstall", agents: targets.map((target) => target.id) });
  assert.equal(response.status, 200);
  state = await request("state").then((response) => response.json());
  assert.equal(state.agents.every((agent) => agent.state === "absent"), true);
  assert.equal((await getProjectSettings(projectDirectory)).exists, true);
});

test("batch preflight leaves every config and .env untouched when a target conflicts", async (t) => {
  const { projectDirectory, targets, request } = await fixture(t);
  const target = targets.find((target) => target.id === "cursor");
  await mkdir(path.dirname(target.configPath), { recursive: true });
  const foreign = '{"mcpServers":{"zentao":{"command":"foreign"}}}';
  await writeFile(target.configPath, foreign);
  const response = await request("change", { action: "install", agents: targets.map((target) => target.id) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /其他来源/);
  assert.equal(await readFile(target.configPath, "utf8"), foreign);
  await assert.rejects(readFile(targets[0].configPath), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(projectDirectory, ".env")), { code: "ENOENT" });
});

test("GUI credentials round-trip Unicode and special characters without appearing in API responses or agent configs", async (t) => {
  const { projectDirectory, targets, request } = await fixture(t);
  const account = "机器人-test";
  const password = 'special-fixture #$\\"\n中文';
  const response = await request("settings", { baseUrl: "https://zentao.example.com/subpath", account, password });
  assert.equal(response.status, 200);
  const config = loadRuntimeConfig(path.join(projectDirectory, ".env"));
  assert.equal(config.account, account);
  assert.equal(config.password, password);
  const state = await request("state").then((response) => response.text());
  assert.doesNotMatch(state, /机器人-test|special-fixture|__ZENTAO_MCP_CREDENTIAL/);
  await request("change", { action: "install", agents: ["cursor"] });
  const installed = await readFile(targets.find((target) => target.id === "cursor").configPath, "utf8");
  assert.doesNotMatch(installed, /机器人-test|special-fixture|__ZENTAO_MCP_CREDENTIAL/);
});

test("saving only a URL preserves credentials; changing site or credentials clears the old token", async (t) => {
  const { projectDirectory, request } = await fixture(t);
  const envPath = path.join(projectDirectory, ".env");
  await writeFile(envPath, "# keep\nZENTAO_BASE_URL=https://old.example.com\nZENTAO_ACCOUNT=fixture-account\nZENTAO_PASSWORD=fixture-password\nZENTAO_TOKEN=fixture-token\n");
  assert.equal((await request("settings", { baseUrl: "https://old.example.com", account: "", password: "" })).status, 200);
  assert.equal(loadRuntimeConfig(envPath).initialToken, "fixture-token");
  assert.equal((await request("settings", { baseUrl: "https://new.example.com" })).status, 200);
  const config = loadRuntimeConfig(envPath);
  assert.equal(config.account, "fixture-account");
  assert.equal(config.password, "fixture-password");
  assert.equal(config.initialToken, "");
  assert.match(await readFile(envPath, "utf8"), /# keep/);
});

test("invalid settings and unknown targets are rejected before files are created", async (t) => {
  const { projectDirectory, request } = await fixture(t);
  for (const body of [{ baseUrl: "file:///tmp" }, { baseUrl: "https://user:pass@example.com" }, { baseUrl: "https://example.com", account: "only-account" }]) {
    assert.equal((await request("settings", body)).status, 400);
  }
  assert.equal((await request("change", { action: "install", agents: ["unknown-agent"] })).status, 400);
  await assert.rejects(readFile(path.join(projectDirectory, ".env")), { code: "ENOENT" });
});

test("the UI can shut down its own management server", async (t) => {
  const { app, request } = await fixture(t);
  const closed = new Promise((resolve) => app.server.once("close", resolve));
  assert.equal((await request("shutdown", {})).status, 200);
  await closed;
  assert.equal(app.server.listening, false);
});
