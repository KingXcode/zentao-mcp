import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { updateEnvCredentials } from "../lib/env-credentials.mjs";
import { createRuntimeClient } from "../lib/runtime-client.mjs";
import { loadRuntimeConfig } from "../lib/runtime-config.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("runtime client reloads credentials after the terminal wizard saves them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zentao-runtime-client-test-"));
  const envPath = path.join(directory, ".env");
  const launcherPath = "/fixed/project/scripts/configure-credentials.command";
  await writeFile(
    envPath,
    [
      "ZENTAO_BASE_URL=https://zentao.test",
      "ZENTAO_API_PREFIX=/api.php/v1",
      "ZENTAO_TOKEN=",
      "ZENTAO_ACCOUNT=",
      "ZENTAO_PASSWORD=",
      "ZENTAO_TIMEOUT_MS=1000",
      "",
    ].join("\n"),
  );

  const spawnCalls = [];
  const fetchCalls = [];
  try {
    const client = createRuntimeClient({
      envPath,
      launcherPath,
      platform: "darwin",
      spawnImpl(command, args, options) {
        spawnCalls.push({ command, args, options });
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => {
          child.emit("spawn");
          queueMicrotask(() => child.emit("close", 0));
        });
        return child;
      },
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url: String(url), options });
        if (String(url).endsWith("/tokens")) {
          return jsonResponse({ token: "fresh-runtime-token" });
        }
        return jsonResponse({ products: [{ id: 1 }] });
      },
    });

    await assert.rejects(client.get("/products"), /已打开禅道凭据配置终端.*重新调用/);
    assert.equal(fetchCalls.length, 0);
    assert.deepEqual(spawnCalls, [{
      command: "/usr/bin/open",
      args: ["-a", "Terminal", launcherPath],
      options: { detached: true, stdio: "ignore" },
    }]);

    await updateEnvCredentials(envPath, {
      account: "runtime-account",
      password: "runtime-password",
    });
    assert.deepEqual(await client.get("/products"), { products: [{ id: 1 }] });
    assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
      account: "runtime-account",
      password: "runtime-password",
    });
    assert.equal(fetchCalls[1].options.headers.Token, "fresh-runtime-token");
    assert.equal(loadRuntimeConfig(envPath).initialToken, "fresh-runtime-token");
    assert.doesNotMatch(JSON.stringify(spawnCalls), /runtime-account|runtime-password/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
