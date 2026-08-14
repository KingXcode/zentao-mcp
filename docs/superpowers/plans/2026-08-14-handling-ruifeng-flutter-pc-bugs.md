# 瑞丰 Flutter-PC 禅道 Bug Skill 实施计划

> **供 Agent 执行者使用：**必需的子 Skill：使用 superpowers-zh-subagent-driven-development（推荐）或 superpowers-zh-executing-plans，逐项任务实施本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：**扩展禅道 MCP 的项目 Bug、链接和图片只读能力，并安装个人 Skill `handling-ruifeng-flutter-pc-bugs`，稳定执行瑞丰Flutter-PC Bug 的查询、详情展示和用户选择流程。

**架构：**在现有认证客户端中增加受大小限制的二进制 GET；使用独立的 `zentao-bug-service` 封装分页、人员/状态过滤、链接、详情和图片归属验证；`server.mjs` 仅负责 MCP schema 与输出转换。个人 Skill 只编排 MCP 工具和交互边界，不读取 `.env`，也不复制认证或 API 实现。

**技术栈：**Node.js ES Modules、`node:test`、MCP SDK、Zod、POSIX shell、Codex Skills、Python Skill Creator 脚本

## 全局约束

- 默认项目固定为瑞丰Flutter-PC，禅道项目 ID 为 `502`。
- 默认“需要解决”的状态只包含 `active` 和 `confirmed`。
- 人员映射固定为王昆 `wangk`、朱颂明/朱颂民 `zhusongming`、陈建华 `chenjh`、陈智文 `czw`；当前用户通过 `/user` 动态获取。
- 信息查询阶段不得分析代码、创建分支、修改文件、运行项目测试或提交代码。
- 只有用户明确要求分析、解决或修复时才进入源码仓库选择。
- 当前不在有效 `flutter-pc` 仓库时，列出 `/Users/nsy` 下所有有效候选并等待用户选择；不得自动选择。
- 新 MCP 能力全部只读，不新增修改、关闭、解决、指派或评论 Bug 的工具。
- Skill 不读取、不解析、不复制 `.env`；认证只通过已注册的 `zentao` MCP。
- 图片必须验证属于指定 Bug，只接受 PNG、JPEG、GIF 或 WebP，默认最大 5 MiB。
- 所有成功和错误输出不得泄露 Token、账号、密码或未经清理的认证响应。
- 生产行为必须先观察对应测试 RED，再写最小实现并确认 GREEN。
- 个人 Skill 安装到 `/Users/nsy/.codex/skills/handling-ruifeng-flutter-pc-bugs`；若目标已存在，停止并请用户决定，不覆盖。

---

## 文件结构

项目仓库：

- 修改：`lib/zentao-client.mjs`——增加 Token 认证、401 单次刷新和大小限制的二进制读取。
- 修改：`lib/runtime-client.mjs`——向服务层暴露 `baseUrl` 与 `getBinary`。
- 创建：`lib/zentao-bug-service.mjs`——项目 Bug 分页、过滤、详情映射、链接、图片提取与读取。
- 修改：`lib/mcp-output.mjs`——增加安全的 MCP image content 构造器。
- 修改：`server.mjs`——注册 `list_project_bugs`、`get_bug_image` 并增强 `get_bug_detail`。
- 修改：`package.json`——把新模块加入语法检查。
- 修改：`README.md`——记录七个只读工具及瑞丰Flutter-PC 使用示例。
- 修改：`test/zentao-client.test.mjs`——二进制 GET 的认证、刷新、限制和错误测试。
- 创建：`test/zentao-bug-service.test.mjs`——Bug 服务的分页、过滤、链接、详情和图片测试。
- 修改：`test/mcp-output.test.mjs`——image content 与敏感信息边界测试。

个人 Skill 暂存与安装：

- 创建：`/private/tmp/ruifeng-flutter-pc-skill-build/handling-ruifeng-flutter-pc-bugs/SKILL.md`
- 生成：`/private/tmp/ruifeng-flutter-pc-skill-build/handling-ruifeng-flutter-pc-bugs/agents/openai.yaml`
- 安装：`/Users/nsy/.codex/skills/handling-ruifeng-flutter-pc-bugs/`
- 记录：`.superpowers/sdd/2026-08-14-ruifeng-bug-skill/skill-evaluation.md`（被仓库忽略，仅保留本机评估证据）

### 任务 1：为认证客户端增加受限二进制 GET

**文件：**
- 修改：`lib/zentao-client.mjs`
- 修改：`lib/runtime-client.mjs`
- 测试：`test/zentao-client.test.mjs`
- 测试：`test/runtime-client.test.mjs`

**接口：**
- 消费：现有 `createZentaoClient(options)` 的 Token 刷新、超时、脱敏和凭据持久化。
- 产出：`client.getBinary(path, { maxBytes }) -> { bytes: Uint8Array, contentType: string, contentDisposition: string }`；`createRuntimeClient(...)` 返回对象增加只读 `baseUrl`。

- [ ] **第 1 步：添加二进制成功、大小限制与 401 刷新失败测试**

在 `test/zentao-client.test.mjs` 增加：

```js
function binaryResponse(bytes, {
  status = 200,
  contentType = "image/png",
  contentDisposition = 'attachment; filename="image.png"',
  contentLength,
} = {}) {
  const headers = new Headers({ "Content-Type": contentType, "Content-Disposition": contentDisposition });
  if (contentLength !== undefined) headers.set("Content-Length", String(contentLength));
  return new Response(Uint8Array.from(bytes), { status, headers });
}

test("getBinary uses the token and returns bounded binary metadata", async () => {
  const calls = [];
  const client = makeClient({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return binaryResponse([0x89, 0x50, 0x4e, 0x47]);
    },
  });
  const result = await client.getBinary("/files/41187", { maxBytes: 8 });
  assert.deepEqual([...result.bytes], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(result.contentType, "image/png");
  assert.equal(result.contentDisposition, 'attachment; filename="image.png"');
  assert.equal(calls[0].options.headers.Token, "valid-token");
});

test("getBinary rejects a declared or streamed body over the limit", async () => {
  const declared = makeClient({ fetchImpl: async () => binaryResponse([1], { contentLength: 9 }) });
  await assert.rejects(declared.getBinary("/files/1", { maxBytes: 8 }), /文件超过 8 字节限制/);
  const streamed = makeClient({ fetchImpl: async () => binaryResponse(new Array(9).fill(1)) });
  await assert.rejects(streamed.getBinary("/files/1", { maxBytes: 8 }), /文件超过 8 字节限制/);
});

test("getBinary refreshes once after HTTP 401", async () => {
  const tokens = [];
  const client = makeClient({
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/tokens")) return jsonResponse({ token: "fresh-token" });
      tokens.push(options.headers.Token);
      return tokens.length === 1
        ? binaryResponse([], { status: 401, contentType: "application/json" })
        : binaryResponse([0xff, 0xd8, 0xff], { contentType: "image/jpeg" });
    },
  });
  const result = await client.getBinary("/files/2", { maxBytes: 10 });
  assert.deepEqual(tokens, ["valid-token", "fresh-token"]);
  assert.equal(result.contentType, "image/jpeg");
});

test("getBinary failures use fixed messages without response secrets", async () => {
  const client = makeClient({
    fetchImpl: async () => new Response("valid-token secret-password", { status: 500 }),
  });
  const error = await client.getBinary("/files/3").catch((value) => value);
  assert.match(error.message, /禅道文件读取失败：HTTP 500/);
  assert.doesNotMatch(error.message, /valid-token|secret-password/);
});
```

在 `test/runtime-client.test.mjs` 增加，沿用该文件现有的临时目录模式：

```js
test("runtime client exposes its configured base URL", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zentao-runtime-base-url-test-"));
  const envPath = path.join(directory, ".env");
  try {
    await writeFile(envPath, "ZENTAO_BASE_URL=https://zentao.test/\nZENTAO_TOKEN=token\n");
    const client = createRuntimeClient({ envPath, launcherPath: "/fixed.command" });
    assert.equal(client.baseUrl, "https://zentao.test/");
    assert.equal(typeof client.getBinary, "function");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **第 2 步：运行聚焦测试并确认 RED**

```bash
node --test --test-name-pattern='getBinary|exposes its configured base URL' test/zentao-client.test.mjs test/runtime-client.test.mjs
```

预期：`client.getBinary is not a function`，且 `baseUrl` 为 `undefined`。

- [ ] **第 3 步：编写最小二进制实现**

在 `lib/zentao-client.mjs` 添加：

```js
async function readBytesWithLimit(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`禅道文件超过 ${maxBytes} 字节限制`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error(`禅道文件超过 ${maxBytes} 字节限制`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
```

实现 `requestBinaryWithToken(path, token, maxBytes)`：使用 `buildUrl(baseUrl, apiPrefix, path)`，请求头为 `{ Token: token, Accept: "application/octet-stream,image/*" }`，沿用 `timeoutMs` AbortController；401 抛 `new ZentaoHttpError(401, "禅道文件读取失败：HTTP 401")`，其他错误使用固定“禅道文件读取失败”文案，成功时返回正文、Content-Type 和 Content-Disposition。

实现：

```js
async function getBinary(path, { maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes 必须是正整数");
  if (!currentToken) await refreshToken();
  const tokenUsed = currentToken;
  try {
    return await requestBinaryWithToken(path, tokenUsed, maxBytes);
  } catch (error) {
    if (!(error instanceof ZentaoHttpError) || error.status !== 401) throw error;
    if (refreshPromise) await refreshPromise;
    else if (currentToken === tokenUsed) await refreshToken();
    return requestBinaryWithToken(path, currentToken, maxBytes);
  }
}
```

客户端返回 `{ get, getBinary, redactOutbound, containsOutboundSecret }`。`lib/runtime-client.mjs` 先保存客户端，再返回：

```js
return { ...client, baseUrl: runtimeConfig.baseUrl };
```

- [ ] **第 4 步：运行客户端测试并确认 GREEN**

```bash
node --test test/zentao-client.test.mjs test/runtime-client.test.mjs
```

预期：全部通过；JSON GET、并发 401、正文超时和脱敏测试不回归。

- [ ] **第 5 步：提交客户端能力**

```bash
git add -- lib/zentao-client.mjs lib/runtime-client.mjs test/zentao-client.test.mjs test/runtime-client.test.mjs
git commit -m "feat: add authenticated Zentao binary reads"
```

### 任务 2：实现项目 Bug、链接、详情和图片服务

**文件：**
- 创建：`lib/zentao-bug-service.mjs`
- 创建：`test/zentao-bug-service.test.mjs`

**接口：**
- 消费：`client.get(path, query)`、`client.getBinary(path, { maxBytes })`、`plainText(value)`。
- 产出：`createZentaoBugService({ client, baseUrl, maxImageBytes })`，返回 `listProjectBugs(args)`、`getBugDetail(args)` 和 `getBugImage(args)`；导出 `buildBugWebUrl`、`collectBugImages`、`detectImageMime` 供测试。

- [ ] **第 1 步：编写分页、过滤和链接失败测试**

创建 `test/zentao-bug-service.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createZentaoBugService } from "../lib/zentao-bug-service.mjs";

test("listProjectBugs reads every page and filters accounts and actionable statuses", async () => {
  const calls = [];
  const pages = {
    1: { total: 4, bugs: [
      { id: 1, title: "keep active", status: "active", pri: 1, severity: 2, assignedTo: { account: "wangk", realname: "王昆" } },
      { id: 2, title: "drop closed", status: "closed", pri: 2, severity: 3, assignedTo: "wangk" },
    ] },
    2: { total: 4, bugs: [
      { id: 3, title: "keep confirmed", status: "confirmed", pri: 3, severity: 3, assignedTo: "czw" },
      { id: 4, title: "drop person", status: "active", pri: 2, severity: 2, assignedTo: "someone" },
    ] },
  };
  const service = createZentaoBugService({
    baseUrl: "http://zentao.test/",
    client: { get: async (path, query) => { calls.push({ path, query }); return pages[query.page]; } },
  });
  const result = await service.listProjectBugs({
    projectId: 502,
    assigneeAccounts: ["wangk", "czw"],
    includeCurrentUser: false,
    statuses: ["active", "confirmed"],
    pageSize: 2,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.total, 4);
  assert.equal(result.matched, 2);
  assert.deepEqual(result.bugs.map(({ id }) => id), [1, 3]);
  assert.equal(result.bugs[0].webUrl, "http://zentao.test/index.php?m=bug&f=view&bugID=1");
});

test("listProjectBugs resolves the current account only when requested", async () => {
  const paths = [];
  const service = createZentaoBugService({
    baseUrl: "http://zentao.test",
    client: {
      get: async (path) => {
        paths.push(path);
        if (path === "/user") return { profile: { account: "niesy", realname: "聂嗣洋" } };
        return { total: 2, bugs: [
          { id: 1, status: "active", assignedTo: "niesy" },
          { id: 2, status: "active", assignedTo: "someone" },
        ] };
      },
    },
  });
  const result = await service.listProjectBugs({
    projectId: 502,
    assigneeAccounts: [],
    includeCurrentUser: true,
    statuses: ["active", "confirmed"],
  });
  assert.deepEqual(paths, ["/user", "/projects/502/bugs"]);
  assert.deepEqual(result.bugs.map(({ id }) => id), [1]);
});
```

- [ ] **第 2 步：编写详情图片提取、归属和格式失败测试**

继续添加：

```js
test("getBugDetail extracts deduplicated images from steps files and action comments", async () => {
  const bug = {
    id: 22530,
    title: "CR differs",
    steps: '<p>step</p><img src="/index.php?m=file&f=read&t=png&fileID=10" alt="step.png">',
    files: [{ id: 11, title: "attachment.jpg", extension: "jpg", size: 20 }],
    actions: [{ id: 99, comment: '<p>comment</p><img src="/index.php?m=file&f=read&t=png&fileID=10">' }],
  };
  const service = createZentaoBugService({ baseUrl: "http://zentao.test", client: { get: async () => bug } });
  const detail = await service.getBugDetail({ bugId: 22530, includeActions: true });
  assert.equal(detail.webUrl, "http://zentao.test/index.php?m=bug&f=view&bugID=22530");
  assert.deepEqual(detail.images.map(({ fileId, source }) => [fileId, source]), [[10, "steps"], [11, "file"]]);
  assert.equal(detail.steps, "step");
  assert.equal(detail.actions[0].comment, "comment");
});

test("getBugImage rejects a file that is not attached to the bug", async () => {
  let binaryCalled = false;
  const service = createZentaoBugService({
    baseUrl: "http://zentao.test",
    client: {
      get: async () => ({ id: 1, steps: '<img src="/file?fileID=10">', files: [], actions: [] }),
      getBinary: async () => { binaryCalled = true; },
    },
  });
  await assert.rejects(service.getBugImage({ bugId: 1, fileId: 12 }), /图片不属于 Bug 1/);
  assert.equal(binaryCalled, false);
});

test("getBugImage validates PNG JPEG GIF and WebP signatures", async () => {
  const signatures = [
    { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff, 0xe0] },
    { mime: "image/gif", bytes: [...Buffer.from("GIF89a")] },
    { mime: "image/webp", bytes: [...Buffer.from("RIFF1234WEBP")] },
  ];
  for (const sample of signatures) {
    const service = createZentaoBugService({
      baseUrl: "http://zentao.test",
      client: {
        get: async () => ({ id: 1, steps: '<img src="/file?fileID=10">', files: [], actions: [] }),
        getBinary: async () => ({ bytes: Uint8Array.from(sample.bytes), contentType: "application/octet-stream", contentDisposition: "" }),
      },
    });
    assert.equal((await service.getBugImage({ bugId: 1, fileId: 10 })).mimeType, sample.mime);
  }
});
```

同时覆盖：非图片签名、响应 MIME 与签名不一致、文件超过 5 MiB、`files` 为对象而非数组、同一 fileId 在正文和评论重复出现。

- [ ] **第 3 步：运行服务测试并确认 RED**

```bash
node --test test/zentao-bug-service.test.mjs
```

预期：`ERR_MODULE_NOT_FOUND`，因为服务模块尚不存在。

- [ ] **第 4 步：实现纯辅助函数与服务工厂**

创建 `lib/zentao-bug-service.mjs`：

```js
import { plainText } from "./mcp-output.mjs";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 100;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function buildBugWebUrl(baseUrl, bugId) {
  const url = new URL("/index.php", `${baseUrl.replace(/\/$/, "")}/`);
  url.search = new URLSearchParams({ m: "bug", f: "view", bugID: String(bugId) });
  return url.toString();
}

function accountOf(value) {
  return typeof value === "object" && value !== null ? String(value.account || "") : String(value || "");
}

function userSummary(value) {
  if (!value) return null;
  if (typeof value !== "object") return { account: String(value), realname: "" };
  return { account: value.account || "", realname: value.realname || value.name || "" };
}

function imageTags(html, source, actionId = null) {
  const images = [];
  for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] || "";
    const fileId = Number(new URL(src, "http://placeholder").searchParams.get("fileID"));
    if (!Number.isSafeInteger(fileId) || fileId <= 0) continue;
    const title = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || "";
    images.push({ fileId, source, actionId, title });
  }
  return images;
}
```

`collectBugImages` 合并正文、图片扩展名附件和 action 评论，按 fileId 保留首次来源。`detectImageMime` 检查 PNG/JPEG/GIF/WebP 文件签名。

分页实现必须为：

```js
const first = await client.get(`/projects/${projectId}/bugs`, { page: 1, limit: pageSize });
const all = [...(first.bugs || first.data || [])];
const total = Number(first.total || all.length);
const pages = Math.ceil(total / pageSize);
if (pages > MAX_PAGES) throw new Error(`禅道项目 Bug 分页超过 ${MAX_PAGES} 页限制`);
for (let page = 2; page <= pages; page += 1) {
  const data = await client.get(`/projects/${projectId}/bugs`, { page, limit: pageSize });
  all.push(...(data.bugs || data.data || []));
}
```

另加测试确认报告页数超过 100 时抛固定错误而非返回截断数据。过滤使用账号集合和状态集合。`includeCurrentUser` 为真时先调用 `/user`，读取 `profile.account` 并加入账号集合；profile 缺少账号时抛固定错误。`getBugDetail` 迁移现有 `server.mjs` 的完整字段映射，不删减原响应；增加 `webUrl`、`images` 和可选纯文本 actions。

`getBugImage` 必须先验证归属，再调用：

```js
const binary = await client.getBinary(`/files/${fileId}`, { maxBytes: maxImageBytes });
const mimeType = detectImageMime(binary.bytes);
if (!mimeType) throw new Error("禅道 Bug 图片格式不受支持");
if (binary.contentType.startsWith("image/") && binary.contentType !== mimeType) {
  throw new Error("禅道 Bug 图片类型与内容不一致");
}
return { fileId, mimeType, bytes: binary.bytes };
```

- [ ] **第 5 步：运行服务测试并确认 GREEN**

```bash
node --test test/zentao-bug-service.test.mjs
```

预期：分页、过滤、链接、图片提取、归属和四种格式全部通过。

- [ ] **第 6 步：提交 Bug 服务**

```bash
git add -- lib/zentao-bug-service.mjs test/zentao-bug-service.test.mjs
git commit -m "feat: add Zentao project bug service"
```

### 任务 3：注册 MCP 工具并保持最终出站安全

**文件：**
- 修改：`lib/mcp-output.mjs`
- 修改：`server.mjs`
- 修改：`test/mcp-output.test.mjs`
- 修改：`package.json`
- 修改：`README.md`

**接口：**
- 消费：`createZentaoBugService({ client, baseUrl })` 的三个方法。
- 产出：MCP 工具 `list_project_bugs`、增强后的 `get_bug_detail`、`get_bug_image`；`createMcpOutput(...)` 返回 `{ ok, fail, image }`。

- [ ] **第 1 步：添加 MCP 图片输出失败测试**

```js
test("image output returns only base64 image content", () => {
  const client = makeClient();
  const { image } = createMcpOutput(client.redactOutbound, client.containsOutboundSecret);
  const result = image(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
  assert.deepEqual(result, { content: [{ type: "image", data: "iVBORw==", mimeType: "image/png" }] });
});

test("image output rejects unsupported MIME types", () => {
  const client = makeClient();
  const { image } = createMcpOutput(client.redactOutbound, client.containsOutboundSecret);
  assert.throws(() => image(Uint8Array.from([1]), "image/svg+xml"), /不受支持/);
});
```

- [ ] **第 2 步：运行聚焦测试并确认 RED**

```bash
node --test --test-name-pattern='image output' test/mcp-output.test.mjs
```

预期：`image is not a function`。

- [ ] **第 3 步：实现 image content 构造器**

在 `createMcpOutput` 内增加：

```js
const supportedImages = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const image = (bytes, mimeType) => {
  if (!supportedImages.has(mimeType)) throw new Error("MCP 图片格式不受支持");
  return { content: [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType }] };
};
return { ok, fail, image };
```

- [ ] **第 4 步：在 server 中注册和接线工具**

创建服务：

```js
import { createZentaoBugService } from "./lib/zentao-bug-service.mjs";
const bugService = createZentaoBugService({ client, baseUrl: client.baseUrl });
const { ok, fail, image } = createMcpOutput(client.redactOutbound, client.containsOutboundSecret);
```

注册 `list_project_bugs`：

```js
server.registerTool("list_project_bugs", {
  title: "查询禅道项目 Bug",
  description: "按项目、状态和指派人账号查询全部匹配 Bug，并返回可点击禅道链接。",
  inputSchema: {
    projectId: z.number().int().positive().default(502),
    assigneeAccounts: z.array(z.string().min(1)).default([]),
    includeCurrentUser: z.boolean().default(false),
    statuses: z.array(z.enum(["active", "confirmed", "resolved", "closed", "delay", "postponed"]))
      .default(["active", "confirmed"]),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async (args) => {
  try { return ok(await bugService.listProjectBugs(args)); }
  catch (error) { return fail(error); }
});
```

现有 `get_bug_detail` handler 改为 `bugService.getBugDetail`，schema 和工具名保持不变。注册 `get_bug_image`：

```js
server.registerTool("get_bug_image", {
  title: "读取禅道 Bug 图片",
  description: "读取确认属于指定 Bug 正文、附件或操作历史的图片。",
  inputSchema: { bugId: z.number().int().positive(), fileId: z.number().int().positive() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async (args) => {
  try {
    const result = await bugService.getBugImage(args);
    return image(result.bytes, result.mimeType);
  } catch (error) {
    return fail(error);
  }
});
```

删除 `server.mjs` 中已迁移到服务的重复详情映射，保持其余五个工具契约不变。

- [ ] **第 5 步：更新检查与 README**

在 `package.json` 的 `check` 中加入 `node --check lib/zentao-bug-service.mjs`。README 工具列表加入 `list_project_bugs`、`get_bug_image`，并添加示例：

```text
列出瑞丰Flutter-PC 项目中指派给我的 active 和 confirmed Bug，附禅道链接；等我选择 Bug ID 后再读取详情和图片。
```

- [ ] **第 6 步：运行聚焦和全量测试**

```bash
node --test test/mcp-output.test.mjs test/zentao-bug-service.test.mjs
npm run check
npm test
git diff --check
```

预期：全部通过；七个工具语法有效；测试输出不含敏感信息。

- [ ] **第 7 步：执行获授权的只读集成验证**

使用 MCP SDK 客户端连接 `start.sh`，依次调用：

```text
list_project_bugs({ projectId: 502, assigneeAccounts: [], includeCurrentUser: true, statuses: ["active", "confirmed"] })
get_bug_detail({ bugId: 22530, includeActions: true })
get_bug_image({ bugId: 22530, fileId: 41187 })
```

断言列表结果含 `webUrl`，详情识别 action `287893` 中的文件 `41187`，图片返回 PNG image content。不得打印或读取 `.env` 内容。

- [ ] **第 8 步：提交 MCP 工具与文档**

```bash
git add -- lib/mcp-output.mjs server.mjs test/mcp-output.test.mjs package.json README.md
git commit -m "feat: expose project bug images through MCP"
```

### 任务 4：在没有 Skill 时建立行为基线

**必需子 Skill：**使用 `skill-creator` 和 `superpowers-zh-writing-skills`；遵守其先观察无 Skill 失败、再编写 Skill 的 RED/GREEN 顺序。

**文件：**
- 创建但不提交：`.superpowers/sdd/2026-08-14-ruifeng-bug-skill/skill-evaluation.md`

**接口：**
- 消费：规格中的交互边界和三份合成 MCP 返回。
- 产出：五个全新上下文的无 Skill 对照结果，记录遗漏链接/图片、越界分析、别名错误或自动选仓库的实际行为。

- [ ] **第 1 步：准备三个无敏感信息的压力场景**

场景 A：

```text
用户：查看瑞丰Flutter-PC 中我需要解决的 Bug。
工具返回：active #101、confirmed #102、resolved #103；#101/#102 都有 webUrl。
要求你直接回答用户。
```

场景 B：

```text
用户：查看 Bug 22530 的具体内容。
工具返回：正文、9 条操作历史，以及 action 287893 中的图片 fileId 41187。
要求你直接回答用户。
```

场景 C：

```text
用户：分析并解决 Bug 22530。
当前目录不是 Flutter 仓库；机器上有 /Users/nsy/Workspace/flutter-pc 与 /Users/nsy/Archive/flutter-pc 两个候选。
要求你说明下一步。
```

- [ ] **第 2 步：运行五个全新无 Skill 对照 Agent**

每个 Agent 使用 `fork_turns="none"`，不得告诉它预期答案或计划结论。A/B/C 三种场景至少各出现一次，总计五次；禁止访问真实禅道或修改文件。

- [ ] **第 3 步：逐字记录基线失败**

评估报告使用：

```markdown
| Run | Scenario | Links | Images | Stops before analysis | Waits for repo choice | Alias handling | Verbatim failure |
```

只有观察到至少一种真实失败后才能编写 Skill；如果五次全部符合规格，重新设计更有区分度的场景，不能跳过 RED。

### 任务 5：创建、验证并安装个人 Skill

**文件：**
- 创建：`/private/tmp/ruifeng-flutter-pc-skill-build/handling-ruifeng-flutter-pc-bugs/SKILL.md`
- 生成：`/private/tmp/ruifeng-flutter-pc-skill-build/handling-ruifeng-flutter-pc-bugs/agents/openai.yaml`
- 安装：`/Users/nsy/.codex/skills/handling-ruifeng-flutter-pc-bugs/`
- 更新但不提交：`.superpowers/sdd/2026-08-14-ruifeng-bug-skill/skill-evaluation.md`

**接口：**
- 消费：MCP 工具 `list_project_bugs`、`get_bug_detail`、`get_bug_image`；通用开发 Skills；当前 Git 工作目录。
- 产出：可由 `$handling-ruifeng-flutter-pc-bugs` 显式调用且支持隐式触发的个人 Skill。

- [ ] **第 1 步：确认暂存和安装目标均不存在**

```bash
test ! -e /private/tmp/ruifeng-flutter-pc-skill-build/handling-ruifeng-flutter-pc-bugs
test ! -e /Users/nsy/.codex/skills/handling-ruifeng-flutter-pc-bugs
```

任一命令失败时停止，不删除或覆盖现有目录。

- [ ] **第 2 步：使用 Skill Creator 初始化暂存目录**

```bash
python3 /Users/nsy/.codex/skills/.system/skill-creator/scripts/init_skill.py \
  handling-ruifeng-flutter-pc-bugs \
  --path /private/tmp/ruifeng-flutter-pc-skill-build \
  --interface 'display_name=瑞丰 Flutter-PC Bug' \
  --interface 'short_description=查询瑞丰 Flutter-PC 禅道 Bug、详情与图片' \
  --interface 'default_prompt=Use $handling-ruifeng-flutter-pc-bugs to list my actionable Ruifeng Flutter-PC bugs with links.'
```

- [ ] **第 3 步：用最小 Skill 内容替换模板**

将 SKILL.md 完整写为：

```markdown
---
name: handling-ruifeng-flutter-pc-bugs
description: Use when查看、筛选、读取、分析或解决瑞丰Flutter-PC项目的禅道 Bug，尤其涉及当前账号、王昆、朱颂明或朱颂民、陈建华、陈智文时。
---

# 处理瑞丰 Flutter-PC Bug

## 核心边界

默认项目 ID 为 `502`。默认待处理状态仅为 `active` 和 `confirmed`。所有禅道操作保持只读。

查询或读取 Bug 时，只展示信息并让用户选择。不要分析代码、搜索源码、选择仓库或修改文件。只有用户明确要求“分析”“解决”或“修复”后才进入源码阶段。

## 人员

| 输入 | 账号 |
|---|---|
| 我、当前用户 | 调用 `list_project_bugs` 时设置 `includeCurrentUser: true` |
| 王昆 | `wangk` |
| 朱颂明、朱颂民 | `zhusongming` |
| 陈建华 | `chenjh` |
| 陈智文 | `czw` |

## 查询列表

调用 `list_project_bugs`，传入 `projectId: 502`、`statuses: ["active", "confirmed"]`。查询“我”时传 `includeCurrentUser: true`；查询指定人员时传对应 `assigneeAccounts`。按人员分组，逐条显示 ID、优先级、状态、标题和可点击 `webUrl`。不要截断工具已经返回的匹配结果。

展示后询问：“需要查看或处理哪个 Bug？请提供 Bug ID。”

## 读取详情与图片

收到 Bug ID 后调用 `get_bug_detail`，设置 `includeActions: true`。展示正文、环境、指派、处理状态、操作历史和 `webUrl`。

对详情返回的每个 `images[].fileId` 调用 `get_bug_image` 并实际查看。说明图片来自正文、附件还是哪条操作历史；图片失败不影响文本展示。

完成后停止并询问：“是否需要分析并解决这个 Bug？”不要在同一响应中给出原因分析或修复建议。

## 进入源码阶段

仅在用户明确要求分析、解决或修复后执行：

1. 用 `git rev-parse --show-toplevel` 检查当前仓库。
2. 当前仓库根目录名为 `flutter-pc` 且包含 `.git` 与 `pubspec.yaml` 时使用当前仓库。
3. 否则在 `/Users/nsy` 下搜索名为 `flutter-pc` 的目录，排除 `.git`、`node_modules`、`build`、缓存和系统目录，只保留含 Git 与 `pubspec.yaml` 的候选。
4. 列出候选绝对路径、分支和工作区状态。即使只有一个，也等待用户选择。
5. 用户选择后再使用当时适用的设计、调试、TDD、验证和代码审查 Skills。

## 故障处理

- 没有 `zentao` MCP 工具：要求检查 MCP 配置并新开任务或重启客户端；不要读取 `.env` 代替。
- 没有匹配 Bug：返回 0；不要自行扩大人员或状态范围。
- 没有图片：明确说明正文、附件和评论中均未发现。
- Bug 不属于项目 `502`：展示前提醒用户，等待确认。
- 未找到源码仓库：报告搜索范围并让用户提供路径；不要克隆或创建目录。
```

- [ ] **第 4 步：核对生成的 agents/openai.yaml**

必须恰好包含：

```yaml
interface:
  display_name: "瑞丰 Flutter-PC Bug"
  short_description: "查询瑞丰 Flutter-PC 禅道 Bug、详情与图片"
  default_prompt: "Use $handling-ruifeng-flutter-pc-bugs to list my actionable Ruifeng Flutter-PC bugs with links."
```

不添加图标、颜色、远程 MCP URL或其他未请求字段。

- [ ] **第 5 步：运行 Skill 结构验证**

系统 Python 缺少 PyYAML；使用隔离临时虚拟环境，不修改项目依赖：

```bash
python3 -m venv /private/tmp/ruifeng-skill-validator-venv
/private/tmp/ruifeng-skill-validator-venv/bin/python -m pip install 'PyYAML==6.0.2'
/private/tmp/ruifeng-skill-validator-venv/bin/python \
  /Users/nsy/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  /private/tmp/ruifeng-flutter-pc-skill-build/handling-ruifeng-flutter-pc-bugs
```

预期：验证成功。依赖下载若受沙箱网络限制，按批准流程重跑，不改写验证器或跳过验证。

- [ ] **第 6 步：运行五个带 Skill 的全新 Agent**

使用任务 4 的同一批场景和评分表；每个 Agent 使用 `fork_turns="none"`，显式指示读取暂存 Skill 路径，但不提供预期答案。确认：

- 列表只含 active/confirmed，保留链接并询问 Bug ID。
- 详情读取所有 action 图片，展示后停止在信息阶段。
- “朱颂明”正确映射 `zhusongming`。
- 非当前仓库时列出所有候选并等待选择。

若出现新失败，只针对已观察到的失败最小修改 SKILL.md，重新运行结构验证和受影响场景，直至 GREEN。

- [ ] **第 7 步：安装个人 Skill**

在用户已批准的范围内，以沙箱外写入权限执行：

```bash
cp -R \
  /private/tmp/ruifeng-flutter-pc-skill-build/handling-ruifeng-flutter-pc-bugs \
  /Users/nsy/.codex/skills/handling-ruifeng-flutter-pc-bugs
```

验证安装副本完全一致：

```bash
diff -r \
  /private/tmp/ruifeng-flutter-pc-skill-build/handling-ruifeng-flutter-pc-bugs \
  /Users/nsy/.codex/skills/handling-ruifeng-flutter-pc-bugs
```

预期：`diff` 退出 0。不要删除暂存目录，直到最终验收完成。

### 任务 6：最终验证、独立审查与交付

**文件：**
- 检查：所有本次项目改动
- 检查：`/Users/nsy/.codex/skills/handling-ruifeng-flutter-pc-bugs/`
- 更新但不提交：`.superpowers/sdd/2026-08-14-ruifeng-bug-skill/skill-evaluation.md`

**接口：**
- 消费：任务 1～5 的提交、测试和 Skill 安装结果。
- 产出：干净的项目工作树、已安装的个人 Skill、完整验证证据和使用说明。

- [ ] **第 1 步：运行最终项目验证**

```bash
npm ci
npm test
npm run check
sh -n start.sh
sh -n stop.sh
sh -n scripts/configure-credentials.command
git diff --check
git status --short --branch
```

预期：全部测试 0 失败；Node/Shell/diff 检查退出 0；项目工作树干净。

- [ ] **第 2 步：重新验证已安装 Skill**

```bash
/private/tmp/ruifeng-skill-validator-venv/bin/python \
  /Users/nsy/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  /Users/nsy/.codex/skills/handling-ruifeng-flutter-pc-bugs
diff -r \
  /private/tmp/ruifeng-flutter-pc-skill-build/handling-ruifeng-flutter-pc-bugs \
  /Users/nsy/.codex/skills/handling-ruifeng-flutter-pc-bugs
```

预期：结构验证成功且安装副本无差异。

- [ ] **第 3 步：独立只读代码与 Skill 审查**

审查：二进制读取的 401/超时/脱敏；图片归属、格式和 5 MiB 限制；全部分页和精确过滤；原五个工具契约；Skill 的信息阶段停止点、人员别名和仓库选择；README、规格与实现一致性。

修复任何 Critical 或 Important 后，重新运行受影响聚焦测试、全量测试、Skill 结构验证和相应 forward test。

- [ ] **第 4 步：确认提交和工作区状态**

```bash
git log --oneline -6
git status --short --branch
```

预期：任务 1～3 各有独立实现提交，计划和设计提交可追踪，工作树干净。个人 Skill 位于批准的安装路径；它不属于项目 Git 仓库，因此不创建伪造提交。

- [ ] **第 5 步：交付使用方式**

说明 Codex 需要新开任务或重启以发现新 Skill，并给出：

```text
使用 $handling-ruifeng-flutter-pc-bugs 查看我在瑞丰Flutter-PC中需要解决的 Bug。
```

以及：

```text
使用 $handling-ruifeng-flutter-pc-bugs 查看朱颂明需要解决的 Bug。
```

不声称 Skill 能修改禅道数据；明确只有后续用户指令才会进入源码分析和修复。

## 最终验收

- [ ] `list_project_bugs` 能为项目 `502` 返回全部 active/confirmed 匹配 Bug 和可点击链接。
- [ ] `get_bug_detail` 返回正文、操作历史、`webUrl` 和去重图片元数据。
- [ ] `get_bug_image` 能读取 Bug `22530` action `287893` 中的 PNG `41187`，并拒绝不属于该 Bug 的文件。
- [ ] 新工具保持只读，凭据和所有 Token 世代不出现在出站内容或错误中。
- [ ] Skill 对本人和四位指定人员执行正确账号映射；“朱颂明”映射到 `zhusongming`。
- [ ] Skill 默认排除 resolved、closed、delay 和 postponed。
- [ ] 详情展示后停止并询问，不自动分析代码。
- [ ] 非当前 `flutter-pc` 仓库时列出全部有效候选并等待用户选择。
- [ ] MCP 全量测试、静态检查、Shell 检查、Skill quick validation 和 forward tests 全部通过。
- [ ] 项目工作树干净，个人 Skill 安装在 `/Users/nsy/.codex/skills/handling-ruifeng-flutter-pc-bugs`。
