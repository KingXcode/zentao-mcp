# 禅道终端凭据向导实施计划

> **供 Agent 执行者使用：**必需的子 Skill：使用 superpowers-zh-subagent-driven-development（推荐）或 superpowers-zh-executing-plans，逐项任务实施本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：**当自动登录需要账号密码但 `.env` 尚未配置时，MCP 自动打开独立 macOS Terminal 向导，隐藏采集并原子保存凭据，使下一次工具调用无需重启即可继续登录。

**架构：**凭据 codec 和原子 `.env` 更新作为底层；可测试的 TTY 输入状态机由固定 `.command` 启动器调用；客户端通过动态凭据提供者和缺凭据回调重新加载配置；服务入口只注入固定项目路径与 macOS Terminal launcher。所有秘密继续经过现有最终 MCP 出站安全边界。

**技术栈：**Node.js ES Modules、`node:test`、Node TTY/child_process、dotenv、MCP SDK、macOS `/usr/bin/open`

## 全局约束

- 绝不从 MCP stdio 读取账号密码；账号密码不得进入工具参数、Codex 对话、命令行参数、进程环境或日志。
- 只允许打开固定的项目启动器，不接受任意文件路径或命令。
- 有效 Token 不打开向导；只有 Token 缺失或 GET 401 后需要登录且凭据为空时才打开。
- 缺凭据期间同一 MCP 进程最多成功打开一次窗口；启动失败后允许下一次调用重试。
- 向导不阻塞原 MCP 请求等待用户输入；它打开终端后返回固定的“保存后重新调用”错误。
- 下一次 MCP 调用必须重新读取 `.env`，无需重启进程。
- 密码和确认输入不回显，也不显示星号；任何退出路径恢复 TTY raw 状态。
- 凭据四字段一次性原子写入并保持 `.env` 为 `0600`；保留注释、缩进和 CRLF。
- 无编码元数据的现有明文凭据保持兼容；有元数据的损坏信封固定安全失败。
- 五个 MCP 工具名称、schema、只读注解、业务映射和正常输出结构不变。
- 不读取或修改真实 `.env`，不打开真实 Terminal，不请求真实禅道；自动化使用临时文件和依赖注入。
- 每个生产行为先运行对应失败测试并确认 RED，再写最小实现并确认 GREEN。

---

## 文件结构

- 创建 `lib/credential-env-codec.mjs`：账号密码 base64url-v1 信封的严格序列化与解析。
- 创建 `lib/env-credentials.mjs`：一次性更新账号、密码及两条编码元数据。
- 创建 `test/env-credentials.test.mjs`：临时 `.env` 原子更新与运行时往返。
- 创建 `lib/terminal-input.mjs`：TTY raw-mode 行读取与账号/密码确认状态机。
- 创建 `test/terminal-input.test.mjs`：隐藏输入、确认重试、取消和 raw 恢复测试。
- 创建 `scripts/configure-credentials.mjs`：固定终端向导入口。
- 创建 `scripts/configure-credentials.command`：macOS Terminal 启动器。
- 创建 `lib/credential-wizard.mjs`：固定 `/usr/bin/open -a Terminal` 启动与去重。
- 创建 `test/credential-wizard.test.mjs`：平台、参数、并发与失败重试测试。
- 创建 `lib/runtime-client.mjs`：组合运行时配置、固定 launcher、动态凭据与禅道客户端。
- 创建 `test/runtime-client.test.mjs`：临时 `.env` 下的服务接线集成测试。
- 修改 `lib/runtime-config.mjs`：解析编码凭据。
- 修改 `lib/zentao-client.mjs`：动态加载凭据并触发向导。
- 修改 `test/runtime-config.test.mjs`、`test/zentao-client.test.mjs`：动态认证回归。
- 修改 `server.mjs`：注入动态凭据和固定 launcher。
- 修改 `package.json`：检查新增生产模块和脚本。
- 修改 `.env.example`、`README.md`：终端向导主流程与降级说明。

## Task 1：凭据编码与原子 `.env` 更新

**文件：**
- 创建：`lib/credential-env-codec.mjs`
- 创建：`lib/env-credentials.mjs`
- 创建：`test/env-credentials.test.mjs`
- 修改：`lib/runtime-config.mjs`
- 修改：`test/runtime-config.test.mjs`

**接口：**
- 消费：`atomicReplaceFile(targetPath, content)`。
- 产出：`CREDENTIAL_ENV_ENCODING`、`serializeEnvCredential(value)`、`parseEnvCredential(value, encoding)`、`updateEnvCredentials(envPath, { account, password })`。

- [ ] **第 1 步：编写凭据 codec 和运行时往返失败测试**

创建 `test/env-credentials.test.mjs`，使用临时目录，导入尚不存在的接口：

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { updateEnvCredentials } from "../lib/env-credentials.mjs";
import { loadRuntimeConfig } from "../lib/runtime-config.mjs";

async function withEnv(content, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "zentao-credentials-test-"));
  const envPath = path.join(directory, ".env");
  await writeFile(envPath, content, { mode: 0o644 });
  try { await run(envPath); } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const credentials = {
  account: "机器人 #1\uFEFF",
  password: " p#$$ \\\"quoted\\\"\nline\r",
};

test("updateEnvCredentials round-trips arbitrary credentials through runtime config", async () => {
  await withEnv("ZENTAO_BASE_URL=https://zentao.test\nZENTAO_TOKEN=existing\n", async (envPath) => {
    await updateEnvCredentials(envPath, credentials);
    const loaded = loadRuntimeConfig(envPath);
    assert.equal(loaded.account, credentials.account);
    assert.equal(loaded.password, credentials.password);
    assert.equal(loaded.initialToken, "existing");
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  });
});
```

- [ ] **第 2 步：运行测试并确认 RED**

运行：`node --test test/env-credentials.test.mjs`

预期：`ERR_MODULE_NOT_FOUND`，因为 `lib/env-credentials.mjs` 尚不存在。

- [ ] **第 3 步：实现严格凭据 codec**

创建 `lib/credential-env-codec.mjs`：

```js
const PREFIX = "__ZENTAO_MCP_CREDENTIAL_V1__";
export const CREDENTIAL_ENV_ENCODING = "base64url-v1";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function serializeEnvCredential(value) {
  const bytes = Buffer.from(String(value), "utf8");
  return `"${PREFIX}${bytes.length}.${bytes.toString("base64url")}"`;
}

export function parseEnvCredential(value, encoding) {
  const stored = String(value);
  if (encoding !== CREDENTIAL_ENV_ENCODING) return stored;
  const invalid = () => { throw new Error("禅道凭据编码配置无效"); };
  if (!stored.startsWith(PREFIX)) return invalid();
  const match = /^(\d+)\.([A-Za-z0-9_-]*)$/.exec(stored.slice(PREFIX.length));
  if (!match) return invalid();
  const expectedLength = Number(match[1]);
  if (!Number.isSafeInteger(expectedLength)) return invalid();
  const bytes = Buffer.from(match[2], "base64url");
  if (bytes.length !== expectedLength || bytes.toString("base64url") !== match[2]) return invalid();
  let decoded;
  try { decoded = utf8Decoder.decode(bytes); } catch { return invalid(); }
  if (!Buffer.from(decoded, "utf8").equals(bytes)) return invalid();
  return decoded;
}
```

- [ ] **第 4 步：实现四字段整体更新**

创建 `lib/env-credentials.mjs`。定义固定字段顺序：

```js
const replacements = [
  ["ZENTAO_ACCOUNT", serializeEnvCredential(account)],
  ["ZENTAO_ACCOUNT_ENCODING", CREDENTIAL_ENV_ENCODING],
  ["ZENTAO_PASSWORD", serializeEnvCredential(password)],
  ["ZENTAO_PASSWORD_ENCODING", CREDENTIAL_ENV_ENCODING],
];
```

对每个字段用仅匹配水平空白的正则替换第一个有效行；缺失时按顺序追加。全部变换完成后只调用一次 `atomicReplaceFile(envPath, updated)`。

- [ ] **第 5 步：修改运行时配置解析编码凭据**

在 `loadRuntimeConfig()` 中把账号密码改为：

```js
account: parseEnvCredential(
  values.ZENTAO_ACCOUNT?.trim() || "",
  values.ZENTAO_ACCOUNT_ENCODING?.trim(),
),
password: parseEnvCredential(
  values.ZENTAO_PASSWORD || "",
  values.ZENTAO_PASSWORD_ENCODING?.trim(),
),
```

账号只在无编码元数据的 legacy 明文路径保持原有 `trim()` 语义；编码路径的 Unicode 内容必须原样返回。实现时先计算 `accountEncoding`：无 metadata 时将 `values.ZENTAO_ACCOUNT` trim 后传入 codec，有 metadata 时将 dotenv 解析值原样传入。

- [ ] **第 6 步：运行往返测试并确认 GREEN**

运行：`node --test test/env-credentials.test.mjs test/runtime-config.test.mjs`

预期：新增往返测试和现有 runtime config 测试全部通过。

- [ ] **第 7 步：添加保留格式、重复运行和损坏信封测试**

添加测试：

```js
test("updateEnvCredentials preserves CRLF comments indentation and avoids duplicate fields", async () => {
  const original = "# keep\r\n\tZENTAO_ACCOUNT = old\r\nZENTAO_PASSWORD=old\r\nZENTAO_TIMEOUT_MS=15000\r\n";
  await withEnv(original, async (envPath) => {
    await updateEnvCredentials(envPath, { account: "robot", password: "secret" });
    await updateEnvCredentials(envPath, { account: "robot-2", password: "secret-2" });
    const text = await readFile(envPath, "utf8");
    assert.match(text, /^# keep\r\n\tZENTAO_ACCOUNT=/);
    assert.equal((text.match(/^\s*ZENTAO_ACCOUNT\s*=/gm) || []).length, 1);
    assert.equal((text.match(/^\s*ZENTAO_PASSWORD\s*=/gm) || []).length, 1);
    assert.equal(loadRuntimeConfig(envPath).account, "robot-2");
    assert.equal(loadRuntimeConfig(envPath).password, "secret-2");
  });
});
```

在 `test/runtime-config.test.mjs` 添加无 metadata 明文兼容，以及账号/密码 metadata 存在但前缀、长度、base64url、UTF-8 损坏时统一抛 `禅道凭据编码配置无效` 且错误不含存储值。

- [ ] **第 8 步：运行新增测试并确认 RED**

运行：`node --test test/env-credentials.test.mjs test/runtime-config.test.mjs`

预期：任何尚未覆盖的 CRLF、缩进、重复字段或损坏信封断言以具体断言失败，不是测试语法错误。

- [ ] **第 9 步：补齐格式保留和严格解析的最小实现**

只修改使第 8 步失败断言通过的行匹配、metadata 检查或 codec 校验，不增加新的配置字段或行为。

- [ ] **第 10 步：运行完整 Task 1 测试并确认 GREEN**

运行：`node --test test/env-credentials.test.mjs test/runtime-config.test.mjs test/env-file.test.mjs`

预期：全部通过，现有 Token 持久化测试无回归。

- [ ] **第 11 步：提交 Task 1**

```bash
git add lib/credential-env-codec.mjs lib/env-credentials.mjs lib/runtime-config.mjs test/env-credentials.test.mjs test/runtime-config.test.mjs
git commit -m "feat: persist Zentao credentials safely"
```

## Task 2：隐藏 TTY 输入与固定终端脚本

**文件：**
- 创建：`lib/terminal-input.mjs`
- 创建：`test/terminal-input.test.mjs`
- 创建：`scripts/configure-credentials.mjs`
- 创建：`scripts/configure-credentials.command`
- 修改：`test/start-script.test.mjs`

**接口：**
- 消费：`updateEnvCredentials(envPath, credentials)`。
- 产出：`readTtyLine({ input, output, prompt, hidden })`、`promptForCredentials(options)`、`runCredentialWizard(options)`。

- [ ] **第 1 步：编写隐藏输入状态机失败测试**

使用 `EventEmitter` 构造假的 TTY input，记录 `setRawMode` 调用和 output 文本：

```js
test("readTtyLine hides password characters and restores raw mode", async () => {
  const { input, output, writes, rawModes } = fakeTty();
  const pending = readTtyLine({ input, output, prompt: "密码：", hidden: true });
  input.emit("data", Buffer.from("s3cret\r"));
  assert.equal(await pending, "s3cret");
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(writes.join(""), "密码：\n");
  assert.doesNotMatch(writes.join(""), /s3cret|\*/);
});
```

另加 visible account 回显、Backspace、Ctrl-C 抛固定取消错误且恢复 raw mode 的测试。

- [ ] **第 2 步：运行测试确认 RED**

运行：`node --test test/terminal-input.test.mjs`

预期：`ERR_MODULE_NOT_FOUND`。

- [ ] **第 3 步：实现 `readTtyLine`**

在 `lib/terminal-input.mjs` 中验证 `input.isTTY && output.isTTY && typeof input.setRawMode === "function"`。保存原 `input.isRaw`，进入 raw mode，逐 Unicode code point 处理：Enter 完成、`\u0003` 取消、`\u007f`/`\b` 删除、其他字符追加；visible 模式自行回显字符和退格序列，hidden 模式不回显。所有 resolve/reject 路径移除监听器、恢复原 raw mode 并输出换行。

- [ ] **第 4 步：运行隐藏输入测试并确认 GREEN**

运行：`node --test test/terminal-input.test.mjs`

预期：hidden、visible、Backspace、Ctrl-C 和 raw-mode 恢复测试全部通过。

- [ ] **第 5 步：编写账号密码确认状态机失败测试**

注入按顺序返回值的 `readLine`，分别测试一次成功、首次不一致后成功、三次失败。断言 returned credentials 精确，三次失败抛 `密码确认失败，未修改配置`，所有 output 均不包含输入密码。

- [ ] **第 6 步：运行确认状态机测试并确认 RED**

运行：`node --test --test-name-pattern='credentials|confirmation' test/terminal-input.test.mjs`

预期：`promptForCredentials` 未导出或行为缺失导致失败。

- [ ] **第 7 步：实现账号密码确认状态机**

```js
export async function promptForCredentials({ readLine = readTtyLine, input, output }) {
  let account = "";
  while (!account.trim()) {
    account = await readLine({ input, output, prompt: "禅道账号：", hidden: false });
    if (!account.trim()) output.write("账号不能为空。\n");
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const password = await readLine({ input, output, prompt: "禅道密码：", hidden: true });
    const confirmation = await readLine({ input, output, prompt: "再次确认密码：", hidden: true });
    if (password && password === confirmation) return { account: account.trim(), password };
    output.write(attempt < 3 ? "密码为空或两次输入不一致，请重试。\n" : "密码确认失败，未修改配置。\n");
  }
  throw new Error("密码确认失败，未修改配置");
}
```

- [ ] **第 8 步：运行确认状态机测试并确认 GREEN**

运行：`node --test test/terminal-input.test.mjs`

预期：全部 TTY 与确认状态机测试通过，输出中没有密码或星号。

- [ ] **第 9 步：编写向导入口测试并确认 RED**

测试 `runCredentialWizard({ envPath, input, output, promptImpl, persistImpl, waitForEnter })`：成功时只把凭据交给 `persistImpl`、打印固定成功消息并等待回车；持久化失败只打印固定错误，不打印凭据。预期因入口函数不存在失败。

- [ ] **第 10 步：实现 `scripts/configure-credentials.mjs`**

从 `import.meta.url` 计算项目 `.env`；导出可注入的 `runCredentialWizard()`，仅在 `import.meta.url === pathToFileURL(process.argv[1]).href` 时执行生产入口。生产入口使用 `process.stdin/stdout`、`promptForCredentials` 和 `updateEnvCredentials`。成功消息固定为“禅道账号密码已保存。返回 Codex 后请重新调用原工具。”，随后读取一次回车。

- [ ] **第 11 步：编写固定 `.command` 启动器失败测试**

在 `test/start-script.test.mjs` 添加：

```js
test("credential command launches only the fixed Node wizard", async () => {
  const text = await readFile(new URL("../scripts/configure-credentials.command", import.meta.url), "utf8");
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.match(text, /exec node "\$SCRIPT_DIR\/configure-credentials\.mjs"/);
  assert.doesNotMatch(text, /source|\. \.env|ZENTAO_(?:ACCOUNT|PASSWORD)/);
});
```

运行：`node --test test/start-script.test.mjs`

预期：`ENOENT`，因为 `scripts/configure-credentials.command` 尚不存在。

- [ ] **第 12 步：创建固定 `.command` 启动器**

```sh
#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/configure-credentials.mjs"
```

设置可执行位。运行 `sh -n scripts/configure-credentials.command`，预期退出 0。

- [ ] **第 13 步：运行 Task 2 测试并确认 GREEN**

运行：`node --test test/terminal-input.test.mjs test/start-script.test.mjs && sh -n scripts/configure-credentials.command`

预期：向导入口、TTY、确认和 shell 语法全部通过。

- [ ] **第 14 步：提交 Task 2**

```bash
git add lib/terminal-input.mjs test/terminal-input.test.mjs test/start-script.test.mjs scripts/configure-credentials.mjs scripts/configure-credentials.command
git commit -m "feat: add secure Zentao credential prompt"
```

## Task 3：Terminal launcher 与客户端动态凭据重载

**文件：**
- 创建：`lib/credential-wizard.mjs`
- 创建：`test/credential-wizard.test.mjs`
- 修改：`lib/zentao-client.mjs`
- 修改：`test/zentao-client.test.mjs`

**接口：**
- 消费：固定 `launcherPath`。
- 产出：`createCredentialWizardLauncher(options)`；客户端新增可选 `loadCredentials`、`onCredentialsRequired`。

- [ ] **第 1 步：编写 launcher 参数和平台失败测试**

```js
test("launcher opens only the fixed command in macOS Terminal", async () => {
  const calls = [];
  const launcher = createCredentialWizardLauncher({
    launcherPath: "/project/scripts/configure-credentials.command",
    platform: "darwin",
    spawnImpl: fakeSpawn(calls),
  });
  await launcher.open();
  assert.deepEqual(calls, [{
    command: "/usr/bin/open",
    args: ["-a", "Terminal", "/project/scripts/configure-credentials.command"],
    options: { detached: true, stdio: "ignore" },
  }]);
});
```

非 darwin 断言固定“不支持自动打开终端”错误；不存在任何 path 参数入口。

- [ ] **第 2 步：运行 launcher 测试确认 RED**

运行：`node --test test/credential-wizard.test.mjs`

预期：`ERR_MODULE_NOT_FOUND`。

- [ ] **第 3 步：实现最小 launcher 启动**

实现 darwin 平台固定 spawn、`spawn`/`error` 事件处理、`unref()` 和非 darwin 固定错误；暂不加入并发去重状态。

- [ ] **第 4 步：运行基础 launcher 测试并确认 GREEN**

运行：`node --test test/credential-wizard.test.mjs`

预期：固定参数和平台测试通过。

- [ ] **第 5 步：添加并发、失败重试与 markConfigured 失败测试**

两个并发 `open()` 期望只 spawn 一次；第一次 child error 后第二次调用期望再次 spawn；成功后期望不重复；调用 `markConfigured()` 后期望可再次打开。

- [ ] **第 6 步：运行新增 launcher 测试并确认 RED**

运行：`node --test test/credential-wizard.test.mjs`

预期：并发或重复打开计数断言失败。

- [ ] **第 7 步：实现 launcher 去重状态**

`open()` 在第一次成功 spawn 前共享 `openingPromise`；子进程 `spawn` 事件时调用 `unref()`、标记 `opened=true` 并 resolve；`error` 时清空 promise/状态并用固定错误 reject。`opened=true` 时后续 `open()` 直接返回。`markConfigured()` 设置 `opened=false`，允许未来凭据再次被清空后重新打开。

- [ ] **第 8 步：运行完整 launcher 测试并确认 GREEN**

运行：`node --test test/credential-wizard.test.mjs`

预期：固定参数、平台、并发、失败重试和重置测试全部通过。

- [ ] **第 9 步：编写客户端动态凭据 RED 测试**

```js
test("missing credentials opens the wizard once and reloads credentials on retry", async () => {
  let credentials = { account: "", password: "" };
  let wizardCalls = 0;
  const requests = [];
  const client = makeClient({
    initialToken: "",
    account: "",
    password: "",
    loadCredentials: () => credentials,
    onCredentialsRequired: async () => { wizardCalls += 1; },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/tokens")) return jsonResponse({ token: "fresh" });
      return jsonResponse({ products: [] });
    },
  });
  await assert.rejects(client.get("/products"), /已打开.*重新调用/);
  credentials = { account: "robot", password: "secret" };
  assert.deepEqual(await client.get("/products"), { products: [] });
  assert.equal(wizardCalls, 1);
  assert.equal(JSON.parse(requests[0].options.body).account, "robot");
});
```

另加多个并发缺凭据只回调一次、回调失败后下次重试、动态凭据加入出站秘密集合测试。

- [ ] **第 10 步：运行客户端测试确认 RED**

运行：`node --test --test-name-pattern='credentials|wizard' test/zentao-client.test.mjs`

预期：仍使用静态空凭据，未调用新回调，断言失败。

- [ ] **第 11 步：实现动态凭据认证**

在 options 中增加：

```js
const credentialProvider = loadCredentials || (() => ({ account, password }));
const credentialsRequired = onCredentialsRequired || (async () => {});
```

`performLogin()` 每次 `await credentialProvider()`，将非空账号密码加入 `knownSecrets`；缺任一字段时先 `await credentialsRequired()`，再抛“已打开禅道凭据配置终端；填写并保存后请重新调用”。登录请求 body 使用本轮动态值。现有 `refreshPromise.finally` 保证失败后下一次调用可重新读取。

- [ ] **第 12 步：运行客户端与 launcher 测试确认 GREEN**

运行：`node --test test/credential-wizard.test.mjs test/zentao-client.test.mjs`

预期：新增与现有客户端测试全部通过。

- [ ] **第 13 步：提交 Task 3**

```bash
git add lib/credential-wizard.mjs lib/zentao-client.mjs test/credential-wizard.test.mjs test/zentao-client.test.mjs
git commit -m "feat: open credential wizard when login is required"
```

## Task 4：MCP 接线、配置示例与文档

**文件：**
- 创建：`lib/runtime-client.mjs`
- 创建：`test/runtime-client.test.mjs`
- 修改：`server.mjs`
- 修改：`package.json`
- 修改：`.env.example`
- 修改：`README.md`

**接口：**
- 消费：`createCredentialWizardLauncher`、`loadRuntimeConfig`、`createZentaoClient`、`updateEnvToken`。
- 产出：`createRuntimeClient({ envPath, launcherPath, fetchImpl, platform, spawnImpl })` 和实际 MCP 完整集成。

- [ ] **第 1 步：编写运行时客户端集成失败测试**

创建 `test/runtime-client.test.mjs`。用临时 `.env`（空 Token、空凭据）、受控 fetch 和 fake spawn 调用 `createRuntimeClient`：第一次 `client.get()` 应只用固定 `/usr/bin/open -a Terminal <launcherPath>` 打开一次并返回重新调用提示；调用 `updateEnvCredentials` 写入临时文件后，第二次 `client.get()` 应重新加载凭据、POST `/tokens`、持久化 Token 并完成 GET。断言不重启 client、账号密码不出现在 spawn 参数。

- [ ] **第 2 步：运行集成测试并确认 RED**

运行：`node --test test/runtime-client.test.mjs`

预期：`ERR_MODULE_NOT_FOUND lib/runtime-client.mjs`。

- [ ] **第 3 步：实现 `createRuntimeClient`**

创建 `lib/runtime-client.mjs`：首次 `loadRuntimeConfig(envPath)` 得到基础 URL、API prefix、Token 和 timeout；创建固定 launcher；创建客户端并注入 `persistToken`、动态 `loadCredentials` 和 `onCredentialsRequired`。动态 loader 每次重新调用 `loadRuntimeConfig`，非空时 `markConfigured()`，只返回 `{ account, password }`。

- [ ] **第 4 步：运行集成测试并确认 GREEN**

运行：`node --test test/runtime-client.test.mjs test/credential-wizard.test.mjs test/zentao-client.test.mjs`

预期：运行时接线、launcher 和客户端测试全部通过，fake spawn 只调用一次。

- [ ] **第 5 步：让 `server.mjs` 使用运行时客户端工厂**

在 `server.mjs` 计算固定路径并调用：

```js
const credentialLauncherPath = path.join(projectDirectory, "scripts", "configure-credentials.command");
const client = createRuntimeClient({ envPath, launcherPath: credentialLauncherPath, fetchImpl: fetch });
```

固定路径全部来自 `import.meta.url`，不新增 MCP 工具或路径参数。

- [ ] **第 6 步：扩展语法检查并运行完整测试**

将 `package.json` 的 `check` 加入：

```text
lib/credential-env-codec.mjs
lib/credential-wizard.mjs
lib/env-credentials.mjs
lib/runtime-client.mjs
lib/terminal-input.mjs
scripts/configure-credentials.mjs
```

运行：

```bash
npm test
npm run check
sh -n start.sh
sh -n scripts/configure-credentials.command
git diff --check
```

预期：全部退出 0，测试无警告。

- [ ] **第 7 步：更新 `.env.example`**

保留六个用户字段，并增加空的可选内部元数据字段：

```dotenv
ZENTAO_ACCOUNT=
ZENTAO_ACCOUNT_ENCODING=
ZENTAO_PASSWORD=
ZENTAO_PASSWORD_ENCODING=
```

注释说明向导会自动填写；不要放真实凭据或编码示例。

- [ ] **第 8 步：更新 README**

必须准确说明：首次需要登录时自动打开新的 macOS Terminal；账号可见、密码和确认不回显；保存后重新调用原工具；无需重启 MCP；有效 Token 不弹窗；同一缺失状态只打开一次；自动打开失败时可双击或运行固定 `scripts/configure-credentials.command`；非 macOS 不支持自动打开；凭据以可逆 base64url 信封保存但不是加密；安全仍依赖专用只读账号与 `.env` 的 `0600`。

- [ ] **第 9 步：文档与实现一致性检查**

运行：

```bash
rg -n "ZENTAO_(ACCOUNT|ACCOUNT_ENCODING|PASSWORD|PASSWORD_ENCODING)" README.md .env.example lib/runtime-config.mjs lib/env-credentials.mjs
rg -n "configure-credentials|Terminal|重新调用" README.md server.mjs lib/zentao-client.mjs
```

预期：字段、固定脚本名和提示文案一致；README 不再要求用户预先手动编辑账号密码。

- [ ] **第 10 步：最终验证并提交 Task 4**

```bash
npm test
npm run check
sh -n start.sh
sh -n scripts/configure-credentials.command
git diff --check
git status --short
```

```bash
git add lib/runtime-client.mjs test/runtime-client.test.mjs server.mjs package.json .env.example README.md
git commit -m "docs: wire and explain Zentao credential wizard"
```

## 最终验收

- [ ] 运行 `npm test`，记录实际通过数量和 0 失败。
- [ ] 运行 `npm run check && sh -n start.sh && sh -n scripts/configure-credentials.command && git diff --check`，确认全部退出 0。
- [ ] 运行 `npm audit --omit=dev --json`；若沙箱网络失败，按批准流程联网复核，必须记录真实结果。
- [ ] 审查从计划实现基线到 HEAD 的完整 diff，确认五个 MCP 工具契约未变、无真实凭据和无真实 `.env` 修改。
- [ ] 自动化测试不打开真实 Terminal；若要人工验证 Terminal UI 或真实禅道登录，必须另行取得用户明确授权。
- [ ] `git status --short` 为空，所有实现提交都在当前用户指定的 `main` 分支。
