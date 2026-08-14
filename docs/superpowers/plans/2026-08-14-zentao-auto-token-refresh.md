# 禅道 Token 自动刷新实施计划

> **供 Agent 执行者使用：**必需的子 Skill：使用 superpowers-zh-subagent-driven-development（推荐）或 superpowers-zh-executing-plans，逐项任务实施本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：**让 MCP 在 Token 缺失或失效时，用本机机器人账号自动登录，将新 Token 原子写回 `.env`，并重试原始只读请求一次。

**架构：**把现有 `server.mjs` 中的 HTTP 逻辑提取到可测试的禅道客户端，并用独立模块处理 `.env` 持久化。客户端在内存中管理 Token 和并发刷新 Promise；MCP 层只加载配置、创建客户端并保留现有工具契约。

**技术栈：**Node.js ES Modules、`node:test`、MCP SDK、Zod、dotenv、Fetch API

## 全局约束

- 现有五个 MCP 工具的名称、输入参数和正常输出结构保持不变。
- 认证信息不得进入 MCP 工具参数、正常返回或错误消息。
- 只有 Token 缺失或 GET 返回 HTTP 401 才触发登录；其他错误不刷新。
- 每个原始请求最多进行一次认证重试。
- 并发刷新合并为一次登录和一次 `.env` 写入。
- 新 Token 写回成功后才能更新内存 Token。
- `.env` 写回后权限必须是 `0600`，并继续被 Git 忽略。
- 不新增任何修改禅道业务数据的工具。
- 所有生产行为先写失败测试并亲眼确认 RED，再写最小实现。

---

## 文件结构

- 创建 `lib/env-file.mjs`：安全更新 `.env` 中的 Token。
- 创建 `lib/zentao-client.mjs`：封装 GET、登录、Token 刷新、单次重试和并发去重。
- 创建 `lib/runtime-config.mjs`：用 dotenv 加载并校验 MCP 运行配置。
- 创建 `test/env-file.test.mjs`：真实临时文件上的持久化测试。
- 创建 `test/zentao-client.test.mjs`：使用受控 Fetch 替身测试认证与请求行为。
- 创建 `test/runtime-config.test.mjs`：验证 `.env` 加载、特殊字符和可选 Token。
- 创建 `test/start-script.test.mjs`：验证启动脚本不再通过 shell 解析 `.env`。
- 修改 `server.mjs`：加载 dotenv、创建客户端并替换内联 HTTP 实现。
- 修改 `start.sh`：停止用 shell `source` 解析 `.env`。
- 修改 `package.json`、`package-lock.json`：加入 dotenv、测试和完整语法检查命令。
- 修改 `.env.example`：加入机器人账号和密码配置。
- 修改 `README.md`：记录自动登录、安全边界、配置和故障处理。

### Task 1：实现安全的 `.env` Token 持久化

**文件：**
- 创建：`lib/env-file.mjs`
- 创建：`test/env-file.test.mjs`
- 修改：`package.json`

**接口：**
- 消费：Node.js `fs/promises` 和 `path`。
- 产出：`updateEnvToken(envPath: string, token: string): Promise<void>`。

- [ ] **第 1 步：先为项目添加测试命令**

将 `package.json` 的 scripts 改为：

```json
"scripts": {
  "start": "node server.mjs",
  "test": "node --test",
  "check": "node --check server.mjs"
}
```

任务 3 接入全部模块后再扩展 `check` 命令。

- [ ] **第 2 步：编写替换现有 Token 的失败测试**

创建 `test/env-file.test.mjs`：

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { updateEnvToken } from "../lib/env-file.mjs";

async function withEnvFile(content, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "zentao-env-test-"));
  const envPath = path.join(directory, ".env");
  await writeFile(envPath, content, { mode: 0o644 });
  try {
    await run(envPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("updateEnvToken replaces the token and preserves unrelated content", async () => {
  await withEnvFile(
    "# local config\nZENTAO_BASE_URL=http://zentao\nZENTAO_TOKEN=old-token\nZENTAO_TIMEOUT_MS=15000\n",
    async (envPath) => {
      await updateEnvToken(envPath, "new-token");
      const content = await readFile(envPath, "utf8");
      assert.equal(
        content,
        '# local config\nZENTAO_BASE_URL=http://zentao\nZENTAO_TOKEN="new-token"\nZENTAO_TIMEOUT_MS=15000\n',
      );
    },
  );
});
```

- [ ] **第 3 步：运行测试并确认 RED**

运行：`npm test -- test/env-file.test.mjs`

预期：因 `../lib/env-file.mjs` 不存在而失败，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **第 4 步：实现最小替换逻辑**

创建 `lib/env-file.mjs`，先实现读取、替换、临时写入和重命名：

```js
import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function encodeDotenvValue(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;
}

export async function updateEnvToken(envPath, token) {
  const original = await readFile(envPath, "utf8");
  const replacement = `ZENTAO_TOKEN=${encodeDotenvValue(token)}`;
  const tokenLine = /^(?!\s*#)\s*ZENTAO_TOKEN\s*=[^\r\n]*$/m;
  const updated = tokenLine.test(original)
    ? original.replace(tokenLine, replacement)
    : `${original}${original && !original.endsWith("\n") ? "\n" : ""}${replacement}\n`;
  const temporaryPath = path.join(path.dirname(envPath), `.${path.basename(envPath)}.${randomUUID()}.tmp`);

  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(updated, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, envPath);
    await chmod(envPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
```

- [ ] **第 5 步：运行测试并确认 GREEN**

运行：`npm test -- test/env-file.test.mjs`

预期：1 个测试通过。

- [ ] **第 6 步：添加追加、转义、CRLF 和权限测试**

在同一测试文件中添加：

```js
test("updateEnvToken appends a missing token", async () => {
  await withEnvFile("ZENTAO_BASE_URL=http://zentao", async (envPath) => {
    await updateEnvToken(envPath, "new-token");
    assert.equal(
      await readFile(envPath, "utf8"),
      'ZENTAO_BASE_URL=http://zentao\nZENTAO_TOKEN="new-token"\n',
    );
  });
});

test("updateEnvToken safely quotes special characters", async () => {
  await withEnvFile("ZENTAO_TOKEN=old\n", async (envPath) => {
    await updateEnvToken(envPath, 'a\\b"c\nd\re');
    assert.equal(await readFile(envPath, "utf8"), 'ZENTAO_TOKEN="a\\\\b\\"c\\nd\\re"\n');
  });
});

test("updateEnvToken preserves CRLF line endings", async () => {
  await withEnvFile("A=1\r\nZENTAO_TOKEN=old\r\nB=2\r\n", async (envPath) => {
    await updateEnvToken(envPath, "new");
    assert.equal(await readFile(envPath, "utf8"), 'A=1\r\nZENTAO_TOKEN="new"\r\nB=2\r\n');
  });
});

test("updateEnvToken leaves the env file readable only by its owner", async () => {
  await withEnvFile("ZENTAO_TOKEN=old\n", async (envPath) => {
    await updateEnvToken(envPath, "new");
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  });
});
```

- [ ] **第 7 步：运行新增持久化测试并确认 RED**

运行：`npm test -- test/env-file.test.mjs`

预期：追加、特殊字符、CRLF 或权限测试中至少一项因尚未实现的行为失败；失败应来自断言，而不是测试语法错误。

- [ ] **第 8 步：实现新增持久化行为**

在 `updateEnvToken` 中定义：

```js
const newline = original.includes("\r\n") ? "\r\n" : "\n";
```

追加 Token 时只使用 `newline`；替换正则保持为 `/^(?!\s*#)\s*ZENTAO_TOKEN\s*=[^\r\n]*$/m`，使匹配不吞掉 `\r`。

- [ ] **第 9 步：运行持久化测试并确认 GREEN**

运行：`npm test -- test/env-file.test.mjs`

预期：5 个测试全部通过，无警告。

- [ ] **第 10 步：提交任务 1**

```bash
git add package.json lib/env-file.mjs test/env-file.test.mjs
git commit -m "feat: persist refreshed Zentao token safely"
```

### Task 2：实现认证、刷新和单次重试客户端

**文件：**
- 创建：`lib/zentao-client.mjs`
- 创建：`test/zentao-client.test.mjs`

**接口：**
- 消费：`persistToken(token: string): Promise<void>`，默认由任务 3 注入 `updateEnvToken` 包装函数。
- 产出：`createZentaoClient(options): { get(path: string, query?: Record<string, unknown>): Promise<unknown> }`。
- `options` 精确字段：`baseUrl`、`apiPrefix`、`initialToken`、`account`、`password`、`timeoutMs`、`fetchImpl`、`persistToken`。

- [ ] **第 1 步：创建真实响应和客户端测试辅助函数**

创建 `test/zentao-client.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";

import { createZentaoClient } from "../lib/zentao-client.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(overrides = {}) {
  return createZentaoClient({
    baseUrl: "http://zentao.test",
    apiPrefix: "/api.php/v1",
    initialToken: "valid-token",
    account: "robot",
    password: "secret-password",
    timeoutMs: 1000,
    persistToken: async () => {},
    ...overrides,
  });
}
```

- [ ] **第 2 步：编写有效 Token 不登录的失败测试**

```js
test("get uses an existing token without logging in", async () => {
  const calls = [];
  const client = makeClient({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ products: [] });
    },
  });

  assert.deepEqual(await client.get("/products", { page: 2 }), { products: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://zentao.test/api.php/v1/products?page=2");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Token, "valid-token");
});
```

- [ ] **第 3 步：运行测试并确认 RED**

运行：`npm test -- test/zentao-client.test.mjs`

预期：因 `../lib/zentao-client.mjs` 不存在而失败。

- [ ] **第 4 步：实现带超时的基础 GET**

创建 `lib/zentao-client.mjs`，实现：

```js
function buildUrl(baseUrl, apiPrefix, path, query = {}) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${apiPrefix.replace(/\/$/, "")}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
```

`createZentaoClient` 先只保存 `currentToken`，并让 `get` 使用该 Token 发出 GET、解析 JSON、保留现有 `data.error`/`data.status === "fail"` 判断。

- [ ] **第 5 步：运行测试并确认 GREEN**

运行：`npm test -- test/zentao-client.test.mjs`

预期：有效 Token 测试通过。

- [ ] **第 6 步：编写 Token 缺失时登录并持久化的失败测试**

```js
test("get logs in and persists a token when the token is missing", async () => {
  const calls = [];
  const persisted = [];
  const client = makeClient({
    initialToken: "",
    persistToken: async (token) => persisted.push(token),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/tokens")) return jsonResponse({ token: "fresh-token" });
      return jsonResponse({ projects: [] });
    },
  });

  assert.deepEqual(await client.get("/projects"), { projects: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    account: "robot",
    password: "secret-password",
  });
  assert.deepEqual(persisted, ["fresh-token"]);
  assert.equal(calls[1].options.headers.Token, "fresh-token");
});
```

- [ ] **第 7 步：运行测试并确认 RED**

运行：`npm test -- test/zentao-client.test.mjs`

预期：请求未先调用 `/tokens` 或缺失 Token 被直接使用，断言失败。

- [ ] **第 8 步：实现登录与共享刷新 Promise**

在客户端内部增加：

```js
let refreshPromise = null;

async function performLogin() {
  if (!account || !password) {
    throw new Error("禅道 Token 不可用，且缺少 ZENTAO_ACCOUNT 或 ZENTAO_PASSWORD");
  }
  const response = await fetchWithTimeout(
    fetchImpl,
    buildUrl(baseUrl, apiPrefix, "/tokens"),
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ account, password }),
    },
    timeoutMs,
  );
  let data;
  try {
    data = JSON.parse(await response.text());
  } catch {
    throw new Error(`禅道自动登录失败：HTTP ${response.status}，响应不是 JSON`);
  }
  if (!response.ok) {
    throw new Error(`禅道自动登录失败：HTTP ${response.status}`);
  }
  const freshToken = typeof data?.token === "string" ? data.token.trim() : "";
  if (!freshToken) {
    throw new Error("禅道自动登录失败：响应缺少有效 token");
  }
  await persistToken(freshToken);
  currentToken = freshToken;
  return freshToken;
}

async function refreshToken() {
  if (!refreshPromise) {
    refreshPromise = performLogin().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}
```

`get` 在 `currentToken` 为空时先 `await refreshToken()`。

- [ ] **第 9 步：运行测试并确认 GREEN**

运行：`npm test -- test/zentao-client.test.mjs`

预期：现有两个测试通过。

- [ ] **第 10 步：编写 401 刷新和只重试一次的失败测试**

```js
test("get refreshes an expired token and retries once", async () => {
  const seenTokens = [];
  const client = makeClient({
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/tokens")) return jsonResponse({ token: "fresh-token" });
      seenTokens.push(options.headers.Token);
      return seenTokens.length === 1
        ? jsonResponse({ message: "expired" }, 401)
        : jsonResponse({ products: [{ id: 1 }] });
    },
  });

  assert.deepEqual(await client.get("/products"), { products: [{ id: 1 }] });
  assert.deepEqual(seenTokens, ["valid-token", "fresh-token"]);
});

test("get stops after a refreshed token is also rejected", async () => {
  let loginCount = 0;
  let getCount = 0;
  const client = makeClient({
    fetchImpl: async (url) => {
      if (String(url).endsWith("/tokens")) {
        loginCount += 1;
        return jsonResponse({ token: "still-invalid" });
      }
      getCount += 1;
      return jsonResponse({ message: "unauthorized" }, 401);
    },
  });

  await assert.rejects(client.get("/products"), /HTTP 401/);
  assert.equal(loginCount, 1);
  assert.equal(getCount, 2);
});
```

- [ ] **第 11 步：运行测试并确认 RED**

运行：`npm test -- test/zentao-client.test.mjs`

预期：401 直接抛错，刷新测试失败。

- [ ] **第 12 步：实现一次 401 刷新和重试**

把单次 GET 提取为 `requestWithToken(path, query, token)`，返回解析后的数据；用包含 `status` 的内部错误类型表示 HTTP 错误。`get` 的控制流固定为：

```js
async function get(path, query = {}) {
  if (!currentToken) await refreshToken();
  const tokenUsed = currentToken;
  try {
    return await requestWithToken(path, query, tokenUsed);
  } catch (error) {
    if (error.status !== 401) throw error;
    if (currentToken === tokenUsed) await refreshToken();
    return requestWithToken(path, query, currentToken);
  }
}
```

第二次 `requestWithToken` 的 401 不再捕获，因此不会再次刷新。

- [ ] **第 13 步：运行测试并确认 GREEN**

运行：`npm test -- test/zentao-client.test.mjs`

预期：四个测试全部通过。

- [ ] **第 14 步：添加并发、缺凭据和敏感信息保护测试**

```js
test("concurrent requests share one token refresh", async () => {
  let loginCount = 0;
  const client = makeClient({
    initialToken: "",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/tokens")) {
        loginCount += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return jsonResponse({ token: "shared-token" });
      }
      return jsonResponse({ ok: true });
    },
  });
  await Promise.all([client.get("/projects"), client.get("/products")]);
  assert.equal(loginCount, 1);
});

test("missing credentials fail without issuing a request", async () => {
  let called = false;
  const client = makeClient({
    initialToken: "",
    account: "",
    password: "",
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  await assert.rejects(client.get("/projects"), /ZENTAO_ACCOUNT.*ZENTAO_PASSWORD/);
  assert.equal(called, false);
});

test("login errors do not expose credentials or returned tokens", async () => {
  const client = makeClient({
    initialToken: "",
    account: "sensitive-account",
    password: "sensitive-password",
    fetchImpl: async () =>
      jsonResponse({ message: "bad sensitive-password", token: "leaked-token" }, 401),
  });
  const error = await client.get("/projects").catch((value) => value);
  assert.match(error.message, /禅道自动登录失败.*HTTP 401/);
  assert.doesNotMatch(error.message, /sensitive-account|sensitive-password|leaked-token/);
});
```

继续添加四个边界测试：

```js
test("login rejects a non-JSON response", async () => {
  const client = makeClient({
    initialToken: "",
    fetchImpl: async () => new Response("<html>error</html>", { status: 502 }),
  });
  await assert.rejects(client.get("/projects"), /自动登录失败.*响应不是 JSON/);
});

test("login rejects an empty token", async () => {
  const client = makeClient({
    initialToken: "",
    fetchImpl: async () => jsonResponse({ token: "  " }),
  });
  await assert.rejects(client.get("/projects"), /响应缺少有效 token/);
});

test("a persistence failure does not update the in-memory token", async () => {
  let loginCount = 0;
  const client = makeClient({
    initialToken: "",
    persistToken: async () => {
      throw new Error("disk full");
    },
    fetchImpl: async () => {
      loginCount += 1;
      return jsonResponse({ token: `token-${loginCount}` });
    },
  });
  await assert.rejects(client.get("/projects"), /disk full/);
  await assert.rejects(client.get("/projects"), /disk full/);
  assert.equal(loginCount, 2);
});

test("a non-401 GET error does not trigger login", async () => {
  let callCount = 0;
  const client = makeClient({
    fetchImpl: async () => {
      callCount += 1;
      return jsonResponse({ message: "forbidden" }, 403);
    },
  });
  await assert.rejects(client.get("/projects"), /HTTP 403/);
  assert.equal(callCount, 1);
});
```

运行：`npm test -- test/zentao-client.test.mjs`

预期：新增测试中尚未实现的错误分类或状态处理以断言失败，而不是测试文件语法错误。

补齐最小实现：登录响应解析严格使用上一步 `performLogin` 中的固定错误文案；`persistToken` 必须位于 `currentToken = freshToken` 之前；GET 非成功状态抛出 `new ZentaoHttpError(status, message)`，其中消息格式为 `禅道 API 请求失败：HTTP ${status} ${detail}`。只有 `status === 401` 进入刷新分支。

- [ ] **第 15 步：运行完整客户端测试并确认 GREEN**

运行：`npm test -- test/zentao-client.test.mjs`

预期：所有客户端测试通过，无错误和警告。

- [ ] **第 16 步：提交任务 2**

```bash
git add lib/zentao-client.mjs test/zentao-client.test.mjs
git commit -m "feat: refresh expired Zentao tokens automatically"
```

### Task 3：接入 MCP 服务和安全加载配置

**文件：**
- 创建：`lib/runtime-config.mjs`
- 创建：`test/runtime-config.test.mjs`
- 创建：`test/start-script.test.mjs`
- 修改：`server.mjs:1-55`
- 修改：`start.sh:1-15`
- 修改：`package.json`
- 修改：`package-lock.json`

**接口：**
- 消费：`createZentaoClient(options)`、`updateEnvToken(envPath, token)`。
- 产出：供现有工具使用的 `zentaoGet(path, query)` 包装函数；工具契约不变。

- [ ] **第 1 步：安装 dotenv 并更新锁文件**

运行：`npm install dotenv`

预期：`package.json` dependencies 出现 `dotenv`，`package-lock.json` 同步更新。

- [ ] **第 2 步：编写配置加载与启动脚本失败测试**

创建 `test/runtime-config.test.mjs`，要求 `loadRuntimeConfig(envPath)` 从指定文件返回：`baseUrl`、`apiPrefix`、`initialToken`、`account`、原样保留的 `password`、数值 `timeoutMs` 和绝对 `envPath`。测试至少覆盖空 Token 可用，以及 `ZENTAO_PASSWORD="pa#$$ word"` 不被 shell 展开。

创建 `test/start-script.test.mjs`，读取 `start.sh` 并断言不匹配 `/^\s*\.\s+.*\.env/m`，且匹配 `exec node`。

运行：`npm test -- test/runtime-config.test.mjs test/start-script.test.mjs`

预期：`runtime-config.mjs` 不存在，且当前 `start.sh` 仍包含 `. "$SCRIPT_DIR/.env"`，两个测试均以预期原因失败。

- [ ] **第 3 步：实现安全配置加载与启动脚本**

创建 `lib/runtime-config.mjs`，导出：

```js
export function loadRuntimeConfig(envPath) {
  const envResult = loadEnv({ path: envPath, quiet: true, processEnv: {} });
  if (envResult.error) throw new Error(`无法加载 ${envPath}：${envResult.error.message}`);
  const values = envResult.parsed || {};
  const baseUrl = values.ZENTAO_BASE_URL?.trim();
  if (!baseUrl) throw new Error("缺少环境变量 ZENTAO_BASE_URL");
  return {
    envPath: path.resolve(envPath),
    baseUrl,
    apiPrefix: values.ZENTAO_API_PREFIX?.trim() || "/api.php/v1",
    initialToken: values.ZENTAO_TOKEN?.trim() || "",
    account: values.ZENTAO_ACCOUNT?.trim() || "",
    password: values.ZENTAO_PASSWORD || "",
    timeoutMs: Number(values.ZENTAO_TIMEOUT_MS || 15000),
  };
}
```

修改启动脚本，停止 source `.env`：

将 `start.sh` 改为：

```sh
#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

exec node "$SCRIPT_DIR/server.mjs"
```

运行：`npm test -- test/runtime-config.test.mjs test/start-script.test.mjs && sh -n start.sh`

预期：两个测试通过，shell 语法退出码 0。

- [ ] **第 4 步：在服务入口加载 `.env` 并创建客户端**

在 `server.mjs` 顶部加入：

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateEnvToken } from "./lib/env-file.mjs";
import { createZentaoClient } from "./lib/zentao-client.mjs";
import { loadRuntimeConfig } from "./lib/runtime-config.mjs";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(projectDirectory, ".env");
const runtimeConfig = loadRuntimeConfig(envPath);
```

把 Token 从必填改为可选并创建客户端：

```js
const client = createZentaoClient({
  ...runtimeConfig,
  fetchImpl: fetch,
  persistToken: (token) => updateEnvToken(envPath, token),
});

const zentaoGet = (path, query) => client.get(path, query);
```

删除原 `zentaoGet` 的内联 fetch 实现，保留所有工具和数据转换函数。

同时将 `package.json` 的语法检查扩展为：

```json
"check": "node --check server.mjs && node --check lib/env-file.mjs && node --check lib/zentao-client.mjs && node --check lib/runtime-config.mjs"
```

- [ ] **第 5 步：运行语法检查和全部单元测试**

运行：`npm run check && npm test`

预期：所有模块语法检查及测试通过。

- [ ] **第 6 步：提交任务 3**

```bash
git add server.mjs start.sh package.json package-lock.json lib/runtime-config.mjs test/runtime-config.test.mjs test/start-script.test.mjs
git commit -m "feat: wire automatic authentication into MCP server"
```

### Task 4：更新配置示例和使用文档

**文件：**
- 修改：`.env.example`
- 修改：`README.md`

**接口：**
- 消费：任务 3 的实际配置字段和错误行为。
- 产出：可复制的安装配置和自动登录说明。

- [ ] **第 1 步：更新 `.env.example`**

内容统一为：

```dotenv
ZENTAO_BASE_URL=http://10.10.11.204
ZENTAO_API_PREFIX=/api.php/v1
ZENTAO_TOKEN=
ZENTAO_ACCOUNT=codex-bot
ZENTAO_PASSWORD=请替换为机器人账号密码
ZENTAO_TIMEOUT_MS=15000
```

- [ ] **第 2 步：更新 README 的安装和认证章节**

文档必须明确：

- 使用 `cd /path/to/zentao-mcp`，移除旧的绝对路径。
- 首次可将 `ZENTAO_TOKEN` 留空。
- Token 缺失或业务请求收到 401 时会自动登录、写回 `.env` 并重试一次。
- 密码只由本地 MCP 进程读取，不作为 MCP 工具参数交给 AI。
- `.env` 必须是 `600`，机器人账号只授予读取权限。
- 账号密码错误、登录响应异常、`.env` 不可写的排查方法。
- Codex 注册命令使用 `/absolute/path/to/zentao-mcp/start.sh` 占位路径。

- [ ] **第 3 步：检查文档与实现字段一致**

运行：

```bash
rg -n "ZENTAO_(BASE_URL|API_PREFIX|TOKEN|ACCOUNT|PASSWORD|TIMEOUT_MS)" README.md .env.example server.mjs
```

预期：六个字段命名完全一致；README 不再出现旧路径 `/Users/nsy/Documents/Codex/2026-07-16/ru-gu/outputs/zentao-mcp`。

- [ ] **第 4 步：运行最终验证**

运行：

```bash
npm test
npm run check
sh -n start.sh
git diff --check
git status --short
```

预期：测试全部通过；语法检查通过；shell 语法通过；无空白错误；状态只包含本任务预期文档修改。

- [ ] **第 5 步：提交任务 4**

```bash
git add .env.example README.md
git commit -m "docs: explain automatic Zentao login"
```

## 最终验收

- [ ] 查看 `git log --oneline -5`，确认设计和四个实施任务提交均存在。
- [ ] 再运行 `npm test && npm run check && sh -n start.sh`，记录实际测试数量和退出码。
- [ ] 运行 `git status --short`，确认工作区干净。
- [ ] 检查测试输出和错误消息样例，确认没有账号、密码或 Token。
- [ ] 若公司禅道网络当前可达，用专用只读账号进行一次人工集成验证：备份本地 Token 文本、临时清空 `ZENTAO_TOKEN`、调用一个只读 MCP 查询、确认 `.env` 获得新 Token 和权限 `0600`。该步骤会真实登录内部服务，执行前必须由用户明确允许；自动化验证不依赖它。
