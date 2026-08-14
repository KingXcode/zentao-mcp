import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { updateEnvToken } from "../lib/env-file.mjs";
import { loadRuntimeConfig } from "../lib/runtime-config.mjs";

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
        '# local config\nZENTAO_BASE_URL=http://zentao\nZENTAO_TOKEN="__ZENTAO_MCP_TOKEN_V1__9.bmV3LXRva2Vu"\nZENTAO_TIMEOUT_MS=15000\nZENTAO_TOKEN_ENCODING=base64url-v1\n',
      );
    },
  );
});

test("updateEnvToken preserves blank lines and indentation before a token", async () => {
  await withEnvFile("A=1\n\n\tZENTAO_TOKEN = old\nB=2\n", async (envPath) => {
    await updateEnvToken(envPath, "new-token");
    assert.equal(
      await readFile(envPath, "utf8"),
      'A=1\n\n\tZENTAO_TOKEN="__ZENTAO_MCP_TOKEN_V1__9.bmV3LXRva2Vu"\nB=2\nZENTAO_TOKEN_ENCODING=base64url-v1\n',
    );
  });
});

test("updateEnvToken appends a missing token", async () => {
  await withEnvFile("ZENTAO_BASE_URL=http://zentao", async (envPath) => {
    await updateEnvToken(envPath, "new-token");
    assert.equal(
      await readFile(envPath, "utf8"),
      'ZENTAO_BASE_URL=http://zentao\nZENTAO_TOKEN="__ZENTAO_MCP_TOKEN_V1__9.bmV3LXRva2Vu"\nZENTAO_TOKEN_ENCODING=base64url-v1\n',
    );
  });
});

test("updateEnvToken safely quotes special characters", async () => {
  await withEnvFile("ZENTAO_TOKEN=old\n", async (envPath) => {
    const token = 'a\\b"c\nd\re';
    await updateEnvToken(envPath, token);
    const content = await readFile(envPath, "utf8");
    assert.match(
      content,
      /^ZENTAO_TOKEN="__ZENTAO_MCP_TOKEN_V1__\d+\.[A-Za-z0-9_-]+"\nZENTAO_TOKEN_ENCODING=base64url-v1\n$/,
    );
    assert.equal(content.includes(token), false);
  });
});

test("updateEnvToken preserves CRLF line endings", async () => {
  await withEnvFile("A=1\r\nZENTAO_TOKEN=old\r\nB=2\r\n", async (envPath) => {
    await updateEnvToken(envPath, "new");
    assert.equal(
      await readFile(envPath, "utf8"),
      'A=1\r\nZENTAO_TOKEN="__ZENTAO_MCP_TOKEN_V1__3.bmV3"\r\nB=2\r\nZENTAO_TOKEN_ENCODING=base64url-v1\r\n',
    );
  });
});

test("updateEnvToken leaves the env file readable only by its owner", async () => {
  await withEnvFile("ZENTAO_TOKEN=old\n", async (envPath) => {
    await updateEnvToken(envPath, "new");
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  });
});

test("updateEnvToken round-trips every supported token character through runtime config", async (t) => {
  const cases = [
    ["backslash", "token\\with\\slashes"],
    ["double quote", 'token"with"quotes'],
    ["literal backslash-n", "token\\nwith\\nliterals"],
    ["line feed", "token\nwith\nlines"],
    ["carriage return", "token\rwith\rreturns"],
    ["leading U+FEFF", "\uFEFFtoken"],
  ];

  for (const [name, token] of cases) {
    await t.test(name, async () => {
      await withEnvFile(
        "ZENTAO_BASE_URL=http://zentao.test\nZENTAO_TOKEN=old\n",
        async (envPath) => {
          await updateEnvToken(envPath, token);

          assert.equal(loadRuntimeConfig(envPath).initialToken, token);
          assert.equal((await stat(envPath)).mode & 0o777, 0o600);
        },
      );
    });
  }
});
