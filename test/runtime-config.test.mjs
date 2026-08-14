import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRuntimeConfig } from "../lib/runtime-config.mjs";

test("loadRuntimeConfig reads an empty token and preserves a shell-sensitive password", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zentao-runtime-config-test-"));
  const envPath = path.join(directory, ".env");
  await writeFile(
    envPath,
    [
      "ZENTAO_BASE_URL=https://zentao.test/ ",
      "ZENTAO_API_PREFIX= /api.php/v2/ ",
      "ZENTAO_TOKEN=",
      "ZENTAO_ACCOUNT= robot ",
      'ZENTAO_PASSWORD="pa#$$ word"',
      "ZENTAO_TIMEOUT_MS=2345",
      "",
    ].join("\n"),
  );

  try {
    assert.deepEqual(loadRuntimeConfig(envPath), {
      envPath: path.resolve(envPath),
      baseUrl: "https://zentao.test/",
      apiPrefix: "/api.php/v2/",
      initialToken: "",
      account: "robot",
      password: "pa#$$ word",
      timeoutMs: 2345,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const timeout of ["not-a-number", "Infinity", "0", "-1"]) {
  test(`loadRuntimeConfig rejects invalid timeout ${timeout}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zentao-runtime-config-test-"));
    const envPath = path.join(directory, ".env");
    await writeFile(
      envPath,
      `ZENTAO_BASE_URL=https://zentao.test\nZENTAO_TIMEOUT_MS=${timeout}\n`,
    );

    try {
      assert.throws(
        () => loadRuntimeConfig(envPath),
        /ZENTAO_TIMEOUT_MS 必须是有限的正数/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("loadRuntimeConfig preserves a legacy token that resembles an encoded envelope", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zentao-runtime-config-test-"));
  const envPath = path.join(directory, ".env");
  const token = "__ZENTAO_MCP_TOKEN_V1__3.YWJj";
  await writeFile(
    envPath,
    `ZENTAO_BASE_URL=https://zentao.test\nZENTAO_TOKEN="${token}"\n`,
  );

  try {
    assert.equal(loadRuntimeConfig(envPath).initialToken, token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const { name, token } of [
  { name: "missing envelope prefix", token: "plain-token" },
  { name: "malformed envelope", token: "__ZENTAO_MCP_TOKEN_V1__x.YQ" },
  { name: "length mismatch", token: "__ZENTAO_MCP_TOKEN_V1__2.YQ" },
  { name: "invalid base64url", token: "__ZENTAO_MCP_TOKEN_V1__1.Y*" },
  { name: "non-canonical base64url", token: "__ZENTAO_MCP_TOKEN_V1__1.YR" },
  { name: "invalid UTF-8", token: "__ZENTAO_MCP_TOKEN_V1__1._w" },
]) {
  test(`loadRuntimeConfig rejects encoded token with ${name}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zentao-runtime-config-test-"));
    const envPath = path.join(directory, ".env");
    await writeFile(
      envPath,
      [
        "ZENTAO_BASE_URL=https://zentao.test",
        `ZENTAO_TOKEN="${token}"`,
        "ZENTAO_TOKEN_ENCODING=base64url-v1",
        "",
      ].join("\n"),
    );

    try {
      assert.throws(
        () => loadRuntimeConfig(envPath),
        (error) => {
          assert.equal(error.message, "ZENTAO_TOKEN 编码配置无效");
          assert.equal(error.message.includes(token), false);
          return true;
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
