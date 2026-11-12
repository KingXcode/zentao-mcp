import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { belongsToProject, getAgentTargets, getRegistrationState, parseAgentConfig, updateAgentConfig } from "../lib/agent-config.mjs";

const projectDirectory = path.resolve("/tmp/禅道 project");
const targets = getAgentTargets({ home: "/tmp/agent-home", env: {} });

for (const target of targets) {
  test(`${target.id}: install is idempotent and uninstall preserves other settings`, () => {
    const original = target.format === "toml"
      ? '# 保留此注释\nmodel = "example"\n\n[mcp_servers.other]\ncommand = "other-server"\n'
      : `// 保留此注释\n{ "theme": "dark", "${target.key}": { "other": { "command": "other-server" } } }\n`;
    const installed = updateAgentConfig(original, target, projectDirectory, "install");
    assert.equal(getRegistrationState(installed, target, projectDirectory), "installed");
    assert.match(installed, /保留此注释/);
    assert.equal(updateAgentConfig(installed, target, projectDirectory, "install"), installed);
    const removed = updateAgentConfig(installed, target, projectDirectory, "uninstall");
    assert.deepEqual(parseAgentConfig(removed, target), parseAgentConfig(original, target));
    assert.equal(updateAgentConfig(removed, target, projectDirectory, "uninstall"), removed);
    assert.equal(updateAgentConfig(null, target, projectDirectory, "uninstall"), null);
  });
}

test("new configs can be created for every supported target", () => {
  for (const target of targets) {
    const installed = updateAgentConfig(null, target, projectDirectory, "install");
    const config = parseAgentConfig(installed, target);
    assert.equal(config[target.key].zentao.command, process.execPath);
    assert.deepEqual(config[target.key].zentao.args, [path.join(projectDirectory, "server.mjs")]);
  }
});

test("empty and comment-only editor configs are treated as unconfigured", () => {
  const target = targets.find((target) => target.id === "vscode-local");
  for (const source of ["", "\uFEFF", "  \r\n", "// 尚未配置\r\n", "/* 尚未配置 */\n"]) {
    assert.equal(getRegistrationState(source, target, projectDirectory), "absent");
    assert.equal(updateAgentConfig(source, target, projectDirectory, "uninstall"), source);
    const installed = updateAgentConfig(source, target, projectDirectory, "install");
    assert.equal(getRegistrationState(installed, target, projectDirectory), "installed");
    if (source.includes("尚未配置")) assert.match(installed, /尚未配置/);
  }
});

test("JSONC edits preserve BOM, CRLF, tabs, comments and personal MCP options", () => {
  const target = targets.find((entry) => entry.id === "cursor");
  const original = '\uFEFF{\r\n\t// 保留其他服务\r\n\t"mcpServers": {\r\n\t\t"other": {"url": "https://example.com"},\r\n\t\t"zentao": {\r\n\t\t\t// 保留个人选项\r\n\t\t\t"command": ' + JSON.stringify(path.join(projectDirectory, "start.sh")) + ',\r\n\t\t\t"disabled": true,\r\n\t\t},\r\n\t},\r\n}\r\n';
  const updated = updateAgentConfig(original, target, projectDirectory, "install");
  assert.ok(updated.startsWith("\uFEFF"));
  assert.ok(!/(?<!\r)\n/.test(updated));
  assert.match(updated, /保留个人选项/);
  assert.match(updated, /"other": \{"url": "https:\/\/example.com"\}/);
  assert.equal(parseAgentConfig(updated, target).mcpServers.zentao.disabled, true);
});

test("TOML editing handles quoted tables and multiline text without rewriting unrelated data", () => {
  const target = targets[0];
  const original = '# 原始配置\nmodel = "example"\nnote = """\n[mcp_servers.zentao]\n这不是表\n"""\n\n[mcp_servers."other.name"]\ncommand = "other" # 保留\n\n[mcp_servers.zentao]\ncommand = ' + JSON.stringify(path.join(projectDirectory, "start.sh")) + '\nenabled_tools = ["list_projects"]\n\n[mcp_servers.zentao.env]\nCUSTOM = "preserve"\n';
  const installed = updateAgentConfig(original, target, projectDirectory, "install");
  const config = parseAgentConfig(installed, target);
  assert.equal(config.mcp_servers.zentao.env.CUSTOM, "preserve");
  assert.match(installed, /command = "other" # 保留/);
  const removed = parseAgentConfig(updateAgentConfig(installed, target, projectDirectory, "uninstall"), target);
  assert.equal(removed.note, parseAgentConfig(original, target).note);
  assert.equal(removed.mcp_servers["other.name"].command, "other");
});

test("malformed, duplicate or non-object JSON configuration is refused without disclosing contents", () => {
  const target = targets[1];
  for (const source of ['{"password":secret-value}', '[]', '{"mcpServers": null}', '{"mcpServers": []}', '{"mcpServers":{},"mcpServers":{}}']) {
    assert.throws(() => updateAgentConfig(source, target, projectDirectory, "install"), (error) => {
      assert.match(error.message, /配置格式或结构错误/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    });
  }
  assert.throws(() => updateAgentConfig('mcp_servers = "invalid"', targets[0], projectDirectory, "install"), /配置格式或结构错误/);
});

test("a same-name MCP from another project cannot be overwritten or uninstalled", () => {
  for (const target of targets) {
    const original = target.format === "toml" ? '[mcp_servers.zentao]\ncommand="foreign"\n'
      : JSON.stringify({ [target.key]: { zentao: { command: "foreign", args: [path.join(projectDirectory, "server.mjs")] } } });
    assert.equal(getRegistrationState(original, target, projectDirectory), "conflict");
    for (const action of ["install", "uninstall"]) assert.throws(() => updateAgentConfig(original, target, projectDirectory, action), /其他来源/);
  }
  assert.equal(belongsToProject({ command: "node", args: ["/other/project/server.mjs"] }, projectDirectory), false);
});

test("configuration paths follow OS conventions and explicit config homes", () => {
  const windows = getAgentTargets({ home: "C:\\Users\\Example", platform: "win32", env: { APPDATA: "D:\\Roaming", CODEX_HOME: "D:\\Codex", COPILOT_HOME: "D:\\Copilot" } });
  assert.equal(windows.find((target) => target.id === "codex").configPath, "D:\\Codex\\config.toml");
  assert.equal(windows.find((target) => target.id === "claude-desktop").configPath, "D:\\Roaming\\Claude\\claude_desktop_config.json");
  assert.equal(windows.find((target) => target.id === "vscode-local").configPath, "D:\\Roaming\\Code\\User\\mcp.json");
  assert.equal(windows.find((target) => target.id === "vscode").configPath, "D:\\Copilot\\mcp-config.json");
  const linux = getAgentTargets({ home: "/home/example", platform: "linux", env: { XDG_CONFIG_HOME: "/tmp/xdg" } });
  assert.equal(linux.find((target) => target.id === "claude-desktop").configPath, "/tmp/xdg/Claude/claude_desktop_config.json");
});
