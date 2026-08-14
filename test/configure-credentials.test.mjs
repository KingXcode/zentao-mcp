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
