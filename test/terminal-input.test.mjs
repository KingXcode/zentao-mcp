import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  promptForCredentials,
  readTtyLine,
} from "../lib/terminal-input.mjs";

function fakeTty() {
  const input = new EventEmitter();
  const writes = [];
  const rawModes = [];
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (enabled) => {
    rawModes.push(enabled);
    input.isRaw = enabled;
  };
  input.resume = () => {};
  const output = {
    isTTY: true,
    write(value) {
      writes.push(String(value));
    },
  };
  return { input, output, writes, rawModes };
}

test("readTtyLine hides password characters and restores raw mode", async () => {
  const { input, output, writes, rawModes } = fakeTty();
  const pending = readTtyLine({ input, output, prompt: "密码：", hidden: true });
  input.emit("data", Buffer.from("s3cret\r"));
  assert.equal(await pending, "s3cret");
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(writes.join(""), "密码：\n");
  assert.doesNotMatch(writes.join(""), /s3cret|\*/);
});

test("readTtyLine echoes an editable account without losing Unicode characters", async () => {
  const { input, output, writes } = fakeTty();
  const pending = readTtyLine({ input, output, prompt: "账号：", hidden: false });
  input.emit("data", Buffer.from("机器x\u007f人\r"));
  assert.equal(await pending, "机器人");
  assert.equal(writes.join(""), "账号：机器x\b \b人\n");
});

test("readTtyLine rejects Ctrl-C and restores raw mode without revealing input", async () => {
  const { input, output, writes, rawModes } = fakeTty();
  const pending = readTtyLine({ input, output, prompt: "密码：", hidden: true });
  input.emit("data", Buffer.from("partial\u0003"));
  await assert.rejects(pending, /已取消禅道凭据配置/);
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(writes.join(""), "密码：\n");
  assert.doesNotMatch(writes.join(""), /partial|\*/);
});

test("readTtyLine rejects a non-TTY without changing terminal state", async () => {
  const { input, output, rawModes } = fakeTty();
  input.isTTY = false;
  await assert.rejects(
    readTtyLine({ input, output, prompt: "密码：", hidden: true }),
    /必须在交互式终端中运行/,
  );
  assert.deepEqual(rawModes, []);
});

function promptHarness(values) {
  const calls = [];
  const writes = [];
  let index = 0;
  return {
    calls,
    output: { write: (value) => writes.push(String(value)) },
    readLine: async (options) => {
      calls.push(options);
      return values[index++];
    },
    writes,
  };
}

test("promptForCredentials returns a non-empty account and confirmed password", async () => {
  const harness = promptHarness(["  robot  ", "s3cret", "s3cret"]);
  const credentials = await promptForCredentials({
    readLine: harness.readLine,
    input: {},
    output: harness.output,
  });
  assert.deepEqual(credentials, { account: "robot", password: "s3cret" });
  assert.deepEqual(harness.calls.map(({ hidden }) => hidden), [false, true, true]);
  assert.doesNotMatch(harness.writes.join(""), /s3cret/);
});

test("promptForCredentials retries an empty account and one mismatched confirmation", async () => {
  const harness = promptHarness(["  ", "robot", "first", "wrong", "second", "second"]);
  const credentials = await promptForCredentials({
    readLine: harness.readLine,
    input: {},
    output: harness.output,
  });
  assert.deepEqual(credentials, { account: "robot", password: "second" });
  assert.match(harness.writes.join(""), /账号不能为空/);
  assert.match(harness.writes.join(""), /两次输入不一致/);
  assert.doesNotMatch(harness.writes.join(""), /first|wrong|second/);
});

test("promptForCredentials rejects after three failed confirmations", async () => {
  const harness = promptHarness([
    "robot",
    "one", "bad-one",
    "two", "bad-two",
    "three", "bad-three",
  ]);
  await assert.rejects(
    promptForCredentials({
      readLine: harness.readLine,
      input: {},
      output: harness.output,
    }),
    /密码确认失败，未修改配置/,
  );
  assert.equal(harness.calls.length, 7);
  assert.doesNotMatch(harness.writes.join(""), /one|two|three|bad/);
});
