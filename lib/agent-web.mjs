import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseEnv } from "dotenv";

import { getAgentTargets } from "./agent-config.mjs";
import { applyAgentChange, ensureProjectEnv, getAgentStatus, planAgentChange } from "./agent-manager.mjs";
import { atomicReplaceFile } from "./atomic-file.mjs";
import { CREDENTIAL_ENV_ENCODING, serializeEnvCredential } from "./credential-env-codec.mjs";

const webDirectory = fileURLToPath(new URL("../web/", import.meta.url));
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

export async function getProjectSettings(projectDirectory) {
  let values;
  try {
    values = parseEnv(await readFile(path.join(projectDirectory, ".env"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, baseUrl: "", hasCredentials: false, hasToken: false };
    throw new Error("无法读取项目 .env，请检查文件权限");
  }
  let baseUrl = "";
  try {
    const url = new URL(values.ZENTAO_BASE_URL);
    if (["http:", "https:"].includes(url.protocol)) {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      baseUrl = url.href.replace(/\/$/, "");
    }
  } catch { /* 尚未填写有效地址。 */ }
  return {
    exists: true,
    baseUrl,
    hasCredentials: Boolean(values.ZENTAO_ACCOUNT && values.ZENTAO_PASSWORD),
    hasToken: Boolean(values.ZENTAO_TOKEN),
  };
}

export async function saveProjectSettings(projectDirectory, { baseUrl, account, password } = {}) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error("请输入完整的禅道地址，例如 https://zentao.example.com"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("禅道地址须为 HTTP 或 HTTPS 地址，且不包含账号、密码、查询参数或片段");
  }
  if ((account || password) && (typeof account !== "string" || !account.trim() || typeof password !== "string" || !password)) {
    throw new Error("更换凭据时，请同时填写账号和密码；全部留空会保留原凭据");
  }
  await ensureProjectEnv(projectDirectory);
  const envPath = path.join(projectDirectory, ".env");
  const original = await readFile(envPath, "utf8");
  const oldValues = parseEnv(original);
  const replacements = new Map([["ZENTAO_BASE_URL", JSON.stringify(url.href.replace(/\/$/, ""))]]);
  if (account && password) {
    replacements.set("ZENTAO_ACCOUNT", serializeEnvCredential(account.trim()));
    replacements.set("ZENTAO_ACCOUNT_ENCODING", CREDENTIAL_ENV_ENCODING);
    replacements.set("ZENTAO_PASSWORD", serializeEnvCredential(password));
    replacements.set("ZENTAO_PASSWORD_ENCODING", CREDENTIAL_ENV_ENCODING);
  }
  // 更换站点或账号后，旧站点/旧账号的 Token 必须失效。
  if (account || oldValues.ZENTAO_BASE_URL?.replace(/\/$/, "") !== url.href.replace(/\/$/, "")) {
    replacements.set("ZENTAO_TOKEN", "");
    replacements.set("ZENTAO_TOKEN_ENCODING", "");
  }
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  let updated = original;
  for (const [key, value] of replacements) {
    const line = new RegExp(`^[ \\t]*${key}[ \\t]*=[^\\r\\n]*(\\r?)$`, "gm");
    let found = false;
    updated = updated.replace(line, (_match, cr) => { found = true; return `${key}=${value}${cr}`; });
    if (!found) updated += `${updated && !updated.endsWith("\n") ? newline : ""}${key}=${value}${newline}`;
  }
  if (await readFile(envPath, "utf8") !== original) throw new Error(".env 已被其他程序修改，请重新保存");
  await atomicReplaceFile(envPath, updated);
  return getProjectSettings(projectDirectory);
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new Error("请求内容过长");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error("请求须为 JSON 对象"); }
}

export function createManagementServer({ projectDirectory, targets = getAgentTargets(), nodePath = process.execPath } = {}) {
  const token = randomBytes(32).toString("hex");
  let busy = false;
  let origin;
  const server = createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
      json(403, { error: "仅接受本机工具页面的请求" });
      return;
    }
    const pathname = new URL(request.url, origin).pathname;
    const asset = assets.get(pathname);
    if (request.method === "GET" && asset) {
      try {
        let body = await readFile(path.join(webDirectory, asset[0]), "utf8");
        if (pathname === "/") body = body.replace("__SESSION_TOKEN__", token);
        response.writeHead(200, { "Content-Type": asset[1] });
        response.end(body);
      } catch { json(500, { error: "无法读取工具界面文件" }); }
      return;
    }
    if (!pathname.startsWith("/api/")) { json(404, { error: "页面不存在" }); return; }
    const supplied = Buffer.from(String(request.headers["x-zentao-token"] || ""));
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      json(403, { error: "页面会话已失效，请刷新后重试" });
      return;
    }
    if (request.method === "GET" && pathname === "/api/state") {
      const agents = await Promise.all(targets.map(async (target) => {
        try { return await getAgentStatus(target, projectDirectory); }
        catch (error) { return { ...target, state: "error", error: error.message }; }
      }));
      try { json(200, { agents, projectDirectory, settings: await getProjectSettings(projectDirectory), busy }); }
      catch (error) { json(500, { error: error.message }); }
      return;
    }
    if (request.method !== "POST") { json(405, { error: "不支持此请求方法" }); return; }
    if (request.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) {
      json(403, { error: "请求来源或格式不正确" });
      return;
    }
    if (busy) { json(409, { error: "操作正在进行，请稍后再试" }); return; }
    busy = true;
    try {
      const body = await readJsonBody(request);
      if (pathname === "/api/settings") {
        json(200, { settings: await saveProjectSettings(projectDirectory, body) });
      } else if (pathname === "/api/change") {
        if (!["install", "uninstall"].includes(body.action) || !Array.isArray(body.agents) || !body.agents.length
          || body.agents.some((id) => !targets.some((target) => target.id === id))) {
          throw new Error("请选择有效的 Agent 和操作");
        }
        const selected = targets.filter((target) => body.agents.includes(target.id));
        // 全部预检通过后再写入；重名或格式错误时，整批不落盘。
        const plans = await Promise.all(selected.map((target) => planAgentChange(target, { projectDirectory, action: body.action, nodePath })));
        if (body.action === "install") await ensureProjectEnv(projectDirectory);
        const results = [];
        for (const plan of plans) {
          try {
            const result = await applyAgentChange(plan);
            results.push({ id: plan.target.id, label: plan.target.label, changed: result.changed, backupPath: result.backupPath });
          } catch (error) {
            const reason = error.code ? `写入失败（${error.code}），请检查文件权限` : error.message;
            json(500, { error: `${plan.target.label}：${reason}；此前结果见操作记录`, results });
            return;
          }
        }
        json(200, { results });
      } else if (pathname === "/api/shutdown") {
        json(200, { closed: true });
        setImmediate(() => server.close());
      } else json(404, { error: "接口不存在" });
    } catch (error) {
      json(400, { error: ["/api/change", "/api/settings"].includes(pathname) ? error.message : "操作失败，请重试" });
    } finally { busy = false; }
  });
  return {
    server,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin;
    },
  };
}
