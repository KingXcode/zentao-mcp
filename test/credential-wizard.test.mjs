import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createCredentialWizardLauncher } from "../lib/credential-wizard.mjs";

function spawnedChild({ event = "spawn", error, exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.unrefCount = 0;
  child.unref = () => { child.unrefCount += 1; };
  queueMicrotask(() => {
    child.emit(event, error);
    if (event === "spawn") queueMicrotask(() => child.emit("close", exitCode));
  });
  return child;
}

test("launcher opens only the configured command in macOS Terminal", async () => {
  const calls = [];
  const child = spawnedChild();
  const launcher = createCredentialWizardLauncher({
    launcherPath: "/project/scripts/configure-credentials.command",
    platform: "darwin",
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(launcher.open.length, 0);
  await launcher.open();
  assert.deepEqual(calls, [{
    command: "/usr/bin/open",
    args: ["-a", "Terminal", "/project/scripts/configure-credentials.command"],
    options: { detached: true, stdio: "ignore" },
  }]);
  assert.equal(child.unrefCount, 1);
});

test("launcher rejects non-macOS platforms without spawning a process", async () => {
  let called = false;
  const launcher = createCredentialWizardLauncher({
    launcherPath: "/project/scripts/configure-credentials.command",
    platform: "linux",
    spawnImpl() {
      called = true;
      return spawnedChild();
    },
  });

  await assert.rejects(launcher.open(), (error) => {
    assert.equal(
      error.message,
      "当前平台不支持自动打开禅道凭据配置终端；请在独立交互式终端运行固定启动器：/project/scripts/configure-credentials.command",
    );
    return true;
  });
  assert.equal(called, false);
});

test("launcher shares one in-flight open and suppresses repeats after success", async () => {
  let spawnCount = 0;
  const launcher = createCredentialWizardLauncher({
    launcherPath: "/project/scripts/configure-credentials.command",
    platform: "darwin",
    spawnImpl() {
      spawnCount += 1;
      return spawnedChild();
    },
  });

  await Promise.all([launcher.open(), launcher.open(), launcher.open()]);
  await launcher.open();
  assert.equal(spawnCount, 1);
});

test("launcher retries after an asynchronous open failure", async () => {
  let spawnCount = 0;
  const launcher = createCredentialWizardLauncher({
    launcherPath: "/project/scripts/configure-credentials.command",
    platform: "darwin",
    spawnImpl() {
      spawnCount += 1;
      return spawnCount === 1
        ? spawnedChild({ event: "error", error: new Error("secret failure") })
        : spawnedChild();
    },
  });

  await assert.rejects(launcher.open(), (error) => {
    assert.equal(error.message, "无法打开禅道凭据配置终端");
    assert.doesNotMatch(error.message, /secret failure/);
    return true;
  });
  await launcher.open();
  assert.equal(spawnCount, 2);
});

test("launcher rejects a nonzero open exit and retries on the next call", async () => {
  let spawnCount = 0;
  const launcher = createCredentialWizardLauncher({
    launcherPath: "/project/scripts/configure-credentials.command",
    platform: "darwin",
    spawnImpl() {
      spawnCount += 1;
      return spawnedChild({ exitCode: spawnCount === 1 ? 1 : 0 });
    },
  });

  await assert.rejects(launcher.open(), /无法打开禅道凭据配置终端/);
  await launcher.open();
  assert.equal(spawnCount, 2);
});

test("launcher markConfigured starts a new missing-credential window cycle", async () => {
  let spawnCount = 0;
  const launcher = createCredentialWizardLauncher({
    launcherPath: "/project/scripts/configure-credentials.command",
    platform: "darwin",
    spawnImpl() {
      spawnCount += 1;
      return spawnedChild();
    },
  });

  await launcher.open();
  launcher.markConfigured();
  await launcher.open();
  assert.equal(spawnCount, 2);
});
