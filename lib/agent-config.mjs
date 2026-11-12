import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parse as parseToml, patch as patchToml } from "@decimalturn/toml-patch";
import { applyEdits, getNodeValue, modify, parseTree } from "jsonc-parser";

export const SERVER_NAME = "zentao";

export function getAgentTargets({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const appData = env.APPDATA || p.join(home, "AppData", "Roaming");
  const configHome = env.XDG_CONFIG_HOME || p.join(home, ".config");
  const appConfig = (name) => platform === "darwin"
    ? p.join(home, "Library", "Application Support", name)
    : p.join(platform === "win32" ? appData : configHome, name);
  const targets = [
    ["codex", "Codex", p.join(env.CODEX_HOME || p.join(home, ".codex"), "config.toml"), "toml", "mcp_servers"],
    ["claude-code", "Claude Code", p.join(env.CLAUDE_CONFIG_DIR || home, ".claude.json"), "json", "mcpServers"],
    ["claude-desktop", "Claude Desktop", p.join(appConfig("Claude"), "claude_desktop_config.json"), "json", "mcpServers"],
    ["cursor", "Cursor", p.join(home, ".cursor", "mcp.json"), "json", "mcpServers"],
    ["windsurf", "Windsurf", p.join(home, ".codeium", "windsurf", "mcp_config.json"), "json", "mcpServers"],
    ["vscode", "VS Code / GitHub Copilot", p.join(env.COPILOT_HOME || p.join(home, ".copilot"), "mcp-config.json"), "json", "mcpServers"],
    ["vscode-local", "VS Code（Local / 兼容配置）", p.join(appConfig("Code"), "User", "mcp.json"), "json", "servers"],
    ["gemini", "Gemini CLI", p.join(home, ".gemini", "settings.json"), "json", "mcpServers"],
  ];
  return targets.map(([id, label, configPath, format, key]) => ({ id, label, configPath, format, key }));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [null, Object.prototype].includes(Object.getPrototypeOf(value));
}

function plainValue(value) {
  if (Array.isArray(value)) return value.map(plainValue);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainValue(item)]));
  return value;
}

const sameValue = (left, right) => isDeepStrictEqual(plainValue(left), plainValue(right));

function rejectDuplicateKeys(node) {
  if (node.type === "object") {
    const keys = new Set();
    for (const property of node.children || []) {
      const key = property.children[0].value;
      if (keys.has(key)) throw new Error("配置包含重复字段");
      keys.add(key);
    }
  }
  for (const child of node.children || []) rejectDuplicateKeys(child);
}

export function parseAgentConfig(source, target) {
  try {
    const body = source.startsWith("\uFEFF") ? source.slice(1) : source;
    let value;
    if (target.format === "toml") value = parseToml(body);
    else {
      const errors = [];
      const tree = parseTree(body, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true });
      if (errors.length) throw new Error("无效 JSON");
      if (tree) rejectDuplicateKeys(tree);
      // 编辑器可能预先创建空的 mcp.json；空文件或纯注释文件视为尚未配置。
      value = tree ? getNodeValue(tree) : Object.create(null);
    }
    if (!isObject(value) || (Object.hasOwn(value, target.key) && !isObject(value[target.key]))) {
      throw new Error("配置结构错误");
    }
    return value;
  } catch {
    // 解析器的原始报错可能包含其他 MCP 的密钥，只显示文件位置。
    throw new Error(`${target.label} 配置格式或结构错误，未修改：${target.configPath}`);
  }
}

export function createServerEntry(target, projectDirectory, nodePath = process.execPath) {
  const entry = { command: nodePath, args: [path.join(projectDirectory, "server.mjs")] };
  if (["claude-code", "cursor", "vscode", "vscode-local"].includes(target.id)) entry.type = "stdio";
  return entry;
}

export function belongsToProject(entry, projectDirectory) {
  if (!isObject(entry)) return false;
  if (entry.url || (entry.type && entry.type !== "stdio")) return false;
  const samePath = (left, right) => typeof left === "string" && path.isAbsolute(left)
    && path.normalize(left) === path.normalize(right);
  if (samePath(entry.command, path.join(projectDirectory, "start.sh"))) return true;
  return typeof entry.command === "string" && /^node(?:\.exe)?$/i.test(path.basename(entry.command))
    && Array.isArray(entry.args) && entry.args.length === 1
    && samePath(entry.args[0], path.join(projectDirectory, "server.mjs"));
}

export function getRegistrationState(source, target, projectDirectory) {
  if (source === null) return "absent";
  const data = parseAgentConfig(source, target);
  const servers = data[target.key];
  if (!servers || !Object.hasOwn(servers, SERVER_NAME)) return "absent";
  return belongsToProject(servers[SERVER_NAME], projectDirectory) ? "installed" : "conflict";
}

export function updateAgentConfig(source, target, projectDirectory, action, nodePath) {
  if (!["install", "uninstall"].includes(action)) throw new Error("未知操作");
  if (source === null && action === "uninstall") return null;
  const original = source ?? (target.format === "toml" ? "" : "{}\n");
  const data = parseAgentConfig(original, target);
  const servers = data[target.key] || {};
  const exists = Object.hasOwn(servers, SERVER_NAME);
  if (exists && !belongsToProject(servers[SERVER_NAME], projectDirectory)) {
    throw new Error(`${target.label} 已有其他来源的 zentao，未覆盖或删除。请核对：${target.configPath}`);
  }
  if (!exists && action === "uninstall") return source;

  const nextServers = { ...servers };
  if (action === "uninstall") delete nextServers[SERVER_NAME];
  else nextServers[SERVER_NAME] = { ...servers[SERVER_NAME], ...createServerEntry(target, projectDirectory, nodePath) };
  const next = { ...data, [target.key]: nextServers };
  if (sameValue(data, next)) return source;

  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  let body = original.slice(bom.length);
  let updated;
  try {
    if (target.format === "toml") updated = patchToml(body, next);
    else {
      const indentation = body.match(/\n([\t ]+)"/)?.[1] || "  ";
      const formattingOptions = {
        insertSpaces: !indentation.includes("\t"),
        tabSize: indentation.length,
        eol: body.includes("\r\n") ? "\r\n" : "\n",
      };
      // 已有注册只更新启动字段，保留该项内的注释和个人选项。
      const changes = exists && action === "install"
        ? Object.entries(createServerEntry(target, projectDirectory, nodePath)).map(([key, value]) => [[target.key, SERVER_NAME, key], value])
        : [[[target.key, SERVER_NAME], action === "uninstall" ? undefined : nextServers[SERVER_NAME]]];
      for (const [keys, value] of changes) {
        body = applyEdits(body, modify(body, keys, value, { formattingOptions }));
      }
      updated = body;
    }
    updated = bom + updated;
    if (!sameValue(parseAgentConfig(updated, target), next)) throw new Error("配置校验失败");
  } catch {
    throw new Error(`${target.label} 配置更新校验失败，未修改：${target.configPath}`);
  }
  return updated;
}
