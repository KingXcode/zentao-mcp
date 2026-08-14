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
  try {
    await run(envPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const credentials = {
  account: "机器人 #1\uFEFF",
  password: " p#$$ \\\"quoted\\\"\nline\r",
};

test("updateEnvCredentials round-trips arbitrary credentials through runtime config", async () => {
  await withEnv(
    "ZENTAO_BASE_URL=https://zentao.test\nZENTAO_TOKEN=existing\n",
    async (envPath) => {
      await updateEnvCredentials(envPath, credentials);
      const loaded = loadRuntimeConfig(envPath);
      assert.equal(loaded.account, credentials.account);
      assert.equal(loaded.password, credentials.password);
      assert.equal(loaded.initialToken, "existing");
      assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    },
  );
});

test("updateEnvCredentials preserves CRLF comments indentation and avoids duplicate fields", async () => {
  const original = "# keep\r\nZENTAO_BASE_URL=https://zentao.test\r\n\tZENTAO_ACCOUNT = old\r\nZENTAO_PASSWORD=old\r\nZENTAO_TIMEOUT_MS=15000\r\n";
  await withEnv(original, async (envPath) => {
    await updateEnvCredentials(envPath, { account: "robot", password: "secret" });
    await updateEnvCredentials(envPath, { account: "robot-2", password: "secret-2" });
    const text = await readFile(envPath, "utf8");
    assert.match(text, /^# keep\r\nZENTAO_BASE_URL=https:\/\/zentao\.test\r\n\tZENTAO_ACCOUNT=/);
    assert.equal((text.match(/^\s*ZENTAO_ACCOUNT\s*=/gm) || []).length, 1);
    assert.equal((text.match(/^\s*ZENTAO_ACCOUNT_ENCODING\s*=/gm) || []).length, 1);
    assert.equal((text.match(/^\s*ZENTAO_PASSWORD\s*=/gm) || []).length, 1);
    assert.equal((text.match(/^\s*ZENTAO_PASSWORD_ENCODING\s*=/gm) || []).length, 1);
    assert.equal(loadRuntimeConfig(envPath).account, "robot-2");
    assert.equal(loadRuntimeConfig(envPath).password, "secret-2");
  });
});
