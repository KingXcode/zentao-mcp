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

async function outcomeByNextTurn(promise) {
  return Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    ),
    new Promise((resolve) => setImmediate(() => resolve({ status: "pending" }))),
  ]);
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

test("readTtyLine cleans up when an asynchronous output write fails", async () => {
  const { input, output, rawModes } = fakeTty();
  let writeCount = 0;
  output.write = () => {
    writeCount += 1;
    if (writeCount === 2) throw new Error("unsafe output failure");
  };

  const pending = readTtyLine({ input, output, prompt: "账号：", hidden: false });
  assert.doesNotThrow(() => input.emit("data", Buffer.from("x")));
  await assert.rejects(pending, (error) => {
    assert.equal(error.message, "读取禅道凭据失败");
    assert.doesNotMatch(error.message, /unsafe output failure/);
    return true;
  });
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(input.listenerCount("data"), 0);
});

for (const event of ["end", "close"]) {
  test(`readTtyLine rejects and cleans up when input emits ${event}`, async () => {
    const { input, output, rawModes } = fakeTty();
    const pending = readTtyLine({ input, output, prompt: "密码：", hidden: true });
    input.emit(event);
    const outcome = await outcomeByNextTurn(pending);
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.error.message, "读取禅道凭据失败");
    assert.deepEqual(rawModes, [true, false]);
    assert.equal(input.listenerCount("data"), 0);
  });
}

test("readTtyLine handles output stream errors through the same cleanup path", async () => {
  const { input, rawModes } = fakeTty();
  const output = new EventEmitter();
  output.isTTY = true;
  output.write = () => {};
  const pending = readTtyLine({ input, output, prompt: "密码：", hidden: true });
  assert.doesNotThrow(() => output.emit("error", new Error("unsafe stream failure")));
  await assert.rejects(pending, (error) => {
    assert.equal(error.message, "读取禅道凭据失败");
    assert.doesNotMatch(error.message, /unsafe stream failure/);
    return true;
  });
  assert.deepEqual(rawModes, [true, false]);
});

test("readTtyLine settles safely when its final newline write fails", async () => {
  const { input, output, rawModes } = fakeTty();
  let writeCount = 0;
  output.write = () => {
    writeCount += 1;
    if (writeCount === 2) throw new Error("unsafe newline failure");
  };
  const pending = readTtyLine({ input, output, prompt: "密码：", hidden: true });
  assert.doesNotThrow(() => input.emit("data", Buffer.from("\r")));
  const outcome = await outcomeByNextTurn(pending);
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.error.message, "读取禅道凭据失败");
  assert.deepEqual(rawModes, [true, false]);
});

test("readTtyLine reports raw-mode restoration failures with a fixed error", async () => {
  const { input, output, rawModes } = fakeTty();
  input.setRawMode = (enabled) => {
    rawModes.push(enabled);
    if (!enabled) throw new Error("unsafe restore failure");
    input.isRaw = enabled;
  };
  const pending = readTtyLine({ input, output, prompt: "密码：", hidden: true });
  input.emit("data", Buffer.from("value\r"));
  await assert.rejects(pending, (error) => {
    assert.equal(error.message, "读取禅道凭据失败");
    assert.doesNotMatch(error.message, /unsafe restore failure/);
    return true;
  });
  assert.deepEqual(rawModes, [true, false]);
});

test("readTtyLine restores an initially raw terminal to raw mode", async () => {
  const { input, output, rawModes } = fakeTty();
  input.isRaw = true;
  const pending = readTtyLine({ input, output, prompt: "密码：", hidden: true });
  input.emit("data", Buffer.from("value\r"));
  assert.equal(await pending, "value");
  assert.deepEqual(rawModes, [true, true]);
  assert.equal(input.isRaw, true);
});

test("readTtyLine cleans up partial listener registration failures", async () => {
  const { input, output } = fakeTty();
  const addListener = input.on.bind(input);
  input.on = (event, listener) => {
    if (event === "error") throw new Error("unsafe listener failure");
    return addListener(event, listener);
  };
  await assert.rejects(
    readTtyLine({ input, output, prompt: "密码：", hidden: true }),
    (error) => {
      assert.equal(error.message, "读取禅道凭据失败");
      assert.doesNotMatch(error.message, /unsafe listener failure/);
      return true;
    },
  );
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.isRaw, false);
});

test("readTtyLine does not enter raw mode after a synchronous output stream error", async () => {
  const { input, rawModes } = fakeTty();
  const output = new EventEmitter();
  output.isTTY = true;
  output.write = () => {};
  const addOutputListener = output.on.bind(output);
  output.on = (event, listener) => {
    addOutputListener(event, listener);
    if (event === "error") listener(new Error("unsafe early stream failure"));
    return output;
  };

  await assert.rejects(
    readTtyLine({ input, output, prompt: "密码：", hidden: true }),
    /读取禅道凭据失败/,
  );
  assert.deepEqual(rawModes, [false]);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
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
