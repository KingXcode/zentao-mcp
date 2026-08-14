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
