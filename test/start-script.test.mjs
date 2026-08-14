import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const startScript = await readFile(path.join(projectDirectory, "start.sh"), "utf8");
const execFile = promisify(execFileCallback);

function startFixtureProcess(scriptPath, extraArguments = []) {
  const child = spawn(process.execPath, [scriptPath, ...extraArguments], { stdio: "ignore" });
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

test("start.sh does not source .env through the shell", () => {
  assert.doesNotMatch(startScript, /^\s*\.\s+.*\.env/m);
});

test("start.sh replaces the shell process with node", () => {
  assert.match(startScript, /\bexec\s+node\b/);
});

test("credential command executes only the fixed Node wizard", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zentao-command-test-"));
  const fakeNodePath = path.join(directory, "node");
  const logPath = path.join(directory, "arguments.log");
  await writeFile(fakeNodePath, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$LOG_PATH\"\n");
  await chmod(fakeNodePath, 0o700);

  try {
    await execFile(path.join(projectDirectory, "scripts", "configure-credentials.command"), {
      env: {
        PATH: `${directory}:${process.env.PATH || ""}`,
        LOG_PATH: logPath,
      },
    });
    assert.equal(
      await readFile(logPath, "utf8"),
      `${path.join(projectDirectory, "scripts", "configure-credentials.mjs")}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop.sh terminates every matching server and leaves other Node processes running", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zentao stop [fixture]+-"));
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
      await startFixtureProcess(otherPath, ["node", serverPath]),
    );

    const first = await execFile(stopScriptPath);
    assert.match(first.stdout, /已向 2 个禅道 MCP 实例发送停止信号/);
    await Promise.all(children.slice(0, 2).map((child) => waitForExit(child)));
    assert.equal(children[0].signalCode, "SIGTERM");
    assert.equal(children[1].signalCode, "SIGTERM");
    assert.equal(children[2].exitCode, null);
    assert.equal(children[2].signalCode, null);
    assert.equal(children[3].exitCode, null);
    assert.equal(children[3].signalCode, null);

    const second = await execFile(stopScriptPath);
    assert.equal(second.stdout, "禅道 MCP 未运行。\n");
  } finally {
    await Promise.all(children.map((child) => stopFixtureProcess(child)));
    await rm(directory, { recursive: true, force: true });
    await rm(otherDirectory, { recursive: true, force: true });
  }
});
