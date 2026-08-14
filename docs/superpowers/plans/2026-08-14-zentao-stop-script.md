# 禅道 MCP 停止脚本实施计划

> **供 Agent 执行者使用：**必需的子 Skill：使用 superpowers-zh-subagent-driven-development（推荐）或 superpowers-zh-executing-plans，逐项任务实施本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：**新增可重复执行的 `stop.sh`，一次向本项目全部 MCP Server 实例发送 `TERM`，且不停止其他 Node.js 进程。

**架构：**停止脚本从自身目录推导固定 `server.mjs` 绝对路径，将其安全转义并用 `/usr/bin/pgrep -f` 精确匹配 `node <path>/server.mjs` 命令行末尾。行为测试在带空格的临时项目目录中启动真实隔离子进程，验证多实例停止、非目标隔离和无实例幂等。

**技术栈：**POSIX `sh`、macOS `/usr/bin/pgrep`、Node.js ES Modules、`node:test`

## 全局约束

- 停止范围固定为 `stop.sh` 同目录的 `server.mjs`，不接受路径或 PID 参数。
- 一次处理全部匹配实例，只发送 `TERM`，绝不发送 `KILL`。
- 没有匹配实例时输出“禅道 MCP 未运行。”并以状态 0 退出。
- 项目路径中的空格和扩展正则元字符必须安全处理。
- 进程查找异常使用固定错误并以非零状态退出，不扩大匹配范围。
- 不读取或修改 `.env`，不输出 Token、账号或密码。
- 自动化测试只终止测试在临时目录中创建的进程，不匹配真实项目 MCP。
- 每项生产行为先观察对应测试因功能缺失而 RED，再写最小实现并确认 GREEN。

---

## 文件结构

- 创建 `stop.sh`：发现本项目全部 MCP Server PID 并发送 `TERM`。
- 修改 `test/start-script.test.mjs`：增加临时真实进程隔离测试。
- 修改 `README.md`：增加手动停止与重启说明。

### 任务 1：停止全部本项目 MCP 实例

**文件：**
- 创建：`stop.sh`
- 修改：`test/start-script.test.mjs`
- 修改：`README.md`

**接口：**
- 消费：现有 `start.sh` 的进程形态 `node <project>/server.mjs`。
- 产出：无参数命令 `./stop.sh`；有目标时状态 0 并输出停止数量，无目标时状态 0 并输出“禅道 MCP 未运行。”。

- [ ] **第 1 步：在测试文件中加入真实隔离进程辅助函数**

在 `test/start-script.test.mjs` 的 `node:child_process` 导入中加入 `spawn`，并添加：

```js
function startFixtureProcess(scriptPath) {
  const child = spawn(process.execPath, [scriptPath], { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process ${child.pid} did not exit`));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopFixtureProcess(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await waitForExit(child).catch(() => {});
}
```

同时在 `node:fs/promises` 导入中加入 `copyFile`。

- [ ] **第 2 步：编写停止全部目标且保留非目标的失败测试**

在同一测试文件添加：

```js
test("stop.sh terminates every matching server and leaves other Node processes running", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zentao stop test-"));
  const otherDirectory = await mkdtemp(path.join(tmpdir(), "zentao other test-"));
  const stopScriptPath = path.join(directory, "stop.sh");
  const serverPath = path.join(directory, "server.mjs");
  const otherPath = path.join(otherDirectory, "other.mjs");
  const fixtureSource = "setInterval(() => {}, 1000);\n";
  const children = [];

  try {
    await copyFile(path.join(projectDirectory, "stop.sh"), stopScriptPath);
    await chmod(stopScriptPath, 0o700);
    await writeFile(serverPath, fixtureSource);
    await writeFile(otherPath, fixtureSource);
    children.push(
      await startFixtureProcess(serverPath),
      await startFixtureProcess(serverPath),
      await startFixtureProcess(otherPath),
    );

    const first = await execFile(stopScriptPath);
    assert.match(first.stdout, /已向 2 个禅道 MCP 实例发送停止信号/);
    await Promise.all(children.slice(0, 2).map((child) => waitForExit(child)));
    assert.equal(children[0].signalCode, "SIGTERM");
    assert.equal(children[1].signalCode, "SIGTERM");
    assert.equal(children[2].exitCode, null);
    assert.equal(children[2].signalCode, null);

    const second = await execFile(stopScriptPath);
    assert.equal(second.stdout, "禅道 MCP 未运行。\n");
  } finally {
    await Promise.all(children.map((child) => stopFixtureProcess(child)));
    await rm(directory, { recursive: true, force: true });
    await rm(otherDirectory, { recursive: true, force: true });
  }
});
```

该测试捕获的破坏是：停止脚本缺失、只停止一个目标、误停路径不同的 Node 进程、路径含空格时匹配失败，或无实例时返回错误。

- [ ] **第 3 步：运行测试并确认 RED**

运行：`node --test --test-name-pattern='stop.sh terminates' test/start-script.test.mjs`

预期：以 `ENOENT` 失败，因为项目根目录尚不存在 `stop.sh`。若沙箱禁止进程枚举，先确认失败是 `Operation not permitted`，再按批准流程在沙箱外重跑；不得把测试改成源码文本断言。

- [ ] **第 4 步：创建最小 `stop.sh` 实现**

创建根目录 `stop.sh`：

```sh
#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVER_PATH="$SCRIPT_DIR/server.mjs"
SERVER_PATTERN=$(printf '%s' "$SERVER_PATH" | sed 's/[][(){}.^$*+?|\\]/\\&/g')
MATCH_PATTERN="[n]ode[[:space:]]+$SERVER_PATTERN$"

set +e
PIDS=$(/usr/bin/pgrep -f "$MATCH_PATTERN")
PGREP_STATUS=$?
set -e

case "$PGREP_STATUS" in
  0) ;;
  1)
    echo "禅道 MCP 未运行。"
    exit 0
    ;;
  *)
    echo "无法查找禅道 MCP 进程。" >&2
    exit 1
    ;;
esac

STOPPED=0
for PID in $PIDS; do
  case "$PID" in
    ""|*[!0-9]*) continue ;;
  esac
  if kill -TERM "$PID" 2>/dev/null; then
    STOPPED=$((STOPPED + 1))
  fi
done

if [ "$STOPPED" -eq 0 ]; then
  echo "禅道 MCP 未运行。"
else
  echo "已向 $STOPPED 个禅道 MCP 实例发送停止信号。"
fi
```

使用 `chmod 755 stop.sh` 设置可执行位。不要加入 PID 文件、强制 KILL、命令行参数或 `.env` 读取。

- [ ] **第 5 步：运行行为测试并确认 GREEN**

运行：

```bash
node --test --test-name-pattern='stop.sh terminates' test/start-script.test.mjs
sh -n stop.sh
```

预期：行为测试通过；两个临时目标退出，非目标存活，无实例第二次执行状态为 0；shell 语法检查退出 0。

- [ ] **第 6 步：更新 README 的停止和重启说明**

在 README 安装/使用部分加入：

````markdown
### 手动停止与重启

停止本项目全部 MCP 实例：

```bash
./stop.sh
```

重启：

```bash
./stop.sh
./start.sh
```

`stop.sh` 只向本项目的 `server.mjs` 进程发送 `TERM`；没有运行实例时可安全重复执行。
````

不要声称脚本会强制终止不响应 `TERM` 的进程。

- [ ] **第 7 步：运行完整验证**

运行：

```bash
npm test
npm run check
sh -n start.sh
sh -n stop.sh
sh -n scripts/configure-credentials.command
git diff --check
git status --short
```

预期：全部测试通过且 0 失败；Node 语法、三个 shell/diff 检查退出 0；状态中只包含 `stop.sh`、`test/start-script.test.mjs` 和 `README.md` 的预期变更。

- [ ] **第 8 步：提交实现**

```bash
git add stop.sh test/start-script.test.mjs README.md
git commit -m "feat: add Zentao MCP stop script"
```

## 最终验收

- [ ] `stop.sh` 在 Git 中的模式为 `100755`。
- [ ] 行为测试证明两个目标实例全部退出且非目标实例保持运行。
- [ ] 无目标时脚本输出固定提示并以状态 0 退出。
- [ ] `npm test`、`npm run check`、三个 `sh -n` 和 `git diff --check` 全部通过。
- [ ] 完整 diff 不包含真实 `.env`、凭据、Token、PID 文件或强制 `KILL`。
- [ ] 工作树干净，提交位于用户指定的当前 `main` 分支。
