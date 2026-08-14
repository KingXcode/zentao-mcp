import assert from "node:assert/strict";
import test from "node:test";

import { runCredentialWizard } from "../scripts/configure-credentials.mjs";

test("runCredentialWizard persists credentials then waits without printing secrets", async () => {
  const credentials = { account: "robot-account", password: "secret-password" };
  const writes = [];
  const events = [];
  await runCredentialWizard({
    envPath: "/project/.env",
    input: {},
    output: { write: (value) => writes.push(String(value)) },
    promptImpl: async () => credentials,
    persistImpl: async (envPath, received) => {
      events.push(["persist", envPath, { ...received }]);
    },
    waitForEnter: async () => events.push(["wait"]),
  });

  assert.deepEqual(events, [
    ["persist", "/project/.env", credentials],
    ["wait"],
  ]);
  assert.match(writes.join(""), /禅道账号密码已保存.*重新调用原工具/);
  assert.doesNotMatch(writes.join(""), /robot-account|secret-password/);
});

test("runCredentialWizard reports a fixed error and does not wait after persistence fails", async () => {
  const writes = [];
  let waited = false;
  await assert.rejects(
    runCredentialWizard({
      envPath: "/project/.env",
      input: {},
      output: { write: (value) => writes.push(String(value)) },
      promptImpl: async () => ({
        account: "leaked-account",
        password: "leaked-password",
      }),
      persistImpl: async () => {
        throw new Error("disk failure leaked-password");
      },
      waitForEnter: async () => { waited = true; },
    }),
    (error) => {
      assert.equal(error.message, "保存禅道账号密码失败");
      return true;
    },
  );
  assert.equal(waited, false);
  assert.match(writes.join(""), /保存禅道账号密码失败/);
  assert.doesNotMatch(writes.join(""), /leaked-account|leaked-password|disk failure/);
});

test("runCredentialWizard displays only fixed safe prompt errors", async (t) => {
  for (const { name, promptError, expected } of [
    {
      name: "known cancellation",
      promptError: new Error("已取消禅道凭据配置"),
      expected: "已取消禅道凭据配置",
    },
    {
      name: "unknown reader failure",
      promptError: new Error("reader leaked-account and leaked-password"),
      expected: "读取禅道凭据失败",
    },
  ]) {
    await t.test(name, async () => {
      const writes = [];
      await assert.rejects(
        runCredentialWizard({
          envPath: "/project/.env",
          input: {},
          output: { write: (value) => writes.push(String(value)) },
          promptImpl: async () => { throw promptError; },
          persistImpl: async () => assert.fail("must not persist"),
          waitForEnter: async () => assert.fail("must not wait"),
        }),
        (error) => {
          assert.equal(error.message, expected);
          return true;
        },
      );
      assert.match(writes.join(""), new RegExp(expected));
      assert.doesNotMatch(
        writes.join(""),
        /reader leaked|leaked-account|leaked-password/,
      );
    });
  }
});
