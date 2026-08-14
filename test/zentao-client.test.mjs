import assert from "node:assert/strict";
import test from "node:test";

import { createZentaoClient } from "../lib/zentao-client.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(overrides = {}) {
  return createZentaoClient({
    baseUrl: "http://zentao.test",
    apiPrefix: "/api.php/v1",
    initialToken: "valid-token",
    account: "robot",
    password: "secret-password",
    timeoutMs: 1000,
    persistToken: async () => {},
    ...overrides,
  });
}

test("get uses an existing token without logging in", async () => {
  const calls = [];
  const client = makeClient({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ products: [] });
    },
  });

  assert.deepEqual(await client.get("/products", { page: 2 }), { products: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://zentao.test/api.php/v1/products?page=2");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Token, "valid-token");
});

test("get logs in and persists a token when the token is missing", async () => {
  const calls = [];
  const persisted = [];
  const client = makeClient({
    initialToken: "",
    persistToken: async (token) => persisted.push(token),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/tokens")) return jsonResponse({ token: "fresh-token" });
      return jsonResponse({ projects: [] });
    },
  });

  assert.deepEqual(await client.get("/projects"), { projects: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    account: "robot",
    password: "secret-password",
  });
  assert.deepEqual(persisted, ["fresh-token"]);
  assert.equal(calls[1].options.headers.Token, "fresh-token");
});

test("get refreshes an expired token and retries once", async () => {
  const seenTokens = [];
  const client = makeClient({
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/tokens")) return jsonResponse({ token: "fresh-token" });
      seenTokens.push(options.headers.Token);
      return seenTokens.length === 1
        ? jsonResponse({ message: "expired" }, 401)
        : jsonResponse({ products: [{ id: 1 }] });
    },
  });

  assert.deepEqual(await client.get("/products"), { products: [{ id: 1 }] });
  assert.deepEqual(seenTokens, ["valid-token", "fresh-token"]);
});

test("get stops after a refreshed token is also rejected", async () => {
  let loginCount = 0;
  let getCount = 0;
  const client = makeClient({
    fetchImpl: async (url) => {
      if (String(url).endsWith("/tokens")) {
        loginCount += 1;
        return jsonResponse({ token: "still-invalid" });
      }
      getCount += 1;
      return jsonResponse({ message: "unauthorized" }, 401);
    },
  });

  await assert.rejects(client.get("/products"), /HTTP 401/);
  assert.equal(loginCount, 1);
  assert.equal(getCount, 2);
});

test("concurrent requests share one token refresh", async () => {
  let loginCount = 0;
  let persistenceCount = 0;
  const client = makeClient({
    initialToken: "",
    persistToken: async () => {
      persistenceCount += 1;
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/tokens")) {
        loginCount += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return jsonResponse({ token: "shared-token" });
      }
      return jsonResponse({ ok: true });
    },
  });
  await Promise.all([client.get("/projects"), client.get("/products")]);
  assert.equal(loginCount, 1);
  assert.equal(persistenceCount, 1);
});

test("concurrent 401 responses share one token refresh", async () => {
  let expiredRequestCount = 0;
  let loginCount = 0;
  let persistenceCount = 0;
  let releaseExpiredRequests;
  const bothExpiredRequestsStarted = new Promise((resolve) => {
    releaseExpiredRequests = resolve;
  });
  const client = makeClient({
    persistToken: async () => {
      persistenceCount += 1;
    },
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/tokens")) {
        loginCount += 1;
        return jsonResponse({ token: "shared-token" });
      }
      if (options.headers.Token === "valid-token") {
        expiredRequestCount += 1;
        if (expiredRequestCount === 2) releaseExpiredRequests();
        await bothExpiredRequestsStarted;
        return jsonResponse({ message: "expired" }, 401);
      }
      return jsonResponse({ ok: true });
    },
  });

  assert.deepEqual(
    await Promise.all([client.get("/projects"), client.get("/products")]),
    [{ ok: true }, { ok: true }],
  );
  assert.equal(loginCount, 1);
  assert.equal(persistenceCount, 1);
});

test("missing credentials fail without issuing a request", async () => {
  let called = false;
  const client = makeClient({
    initialToken: "",
    account: "",
    password: "",
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  await assert.rejects(client.get("/projects"), /ZENTAO_ACCOUNT.*ZENTAO_PASSWORD/);
  assert.equal(called, false);
});

test("login errors do not expose credentials or returned tokens", async () => {
  const client = makeClient({
    initialToken: "",
    account: "sensitive-account",
    password: "sensitive-password",
    fetchImpl: async () =>
      jsonResponse({ message: "bad sensitive-password", token: "leaked-token" }, 401),
  });
  const error = await client.get("/projects").catch((value) => value);
  assert.match(error.message, /禅道自动登录失败.*HTTP 401/);
  assert.doesNotMatch(error.message, /sensitive-account|sensitive-password|leaked-token/);
});

test("login rejects a non-JSON response", async () => {
  const client = makeClient({
    initialToken: "",
    fetchImpl: async () => new Response("<html>error</html>", { status: 502 }),
  });
  await assert.rejects(client.get("/projects"), /自动登录失败.*响应不是 JSON/);
});

test("login rejects an empty token", async () => {
  const client = makeClient({
    initialToken: "",
    fetchImpl: async () => jsonResponse({ token: "  " }),
  });
  await assert.rejects(client.get("/projects"), /响应缺少有效 token/);
});

test("a persistence failure does not update the in-memory token", async () => {
  let loginCount = 0;
  const client = makeClient({
    initialToken: "",
    persistToken: async () => {
      throw new Error("disk full");
    },
    fetchImpl: async () => {
      loginCount += 1;
      return jsonResponse({ token: `token-${loginCount}` });
    },
  });
  await assert.rejects(client.get("/projects"), /disk full/);
  await assert.rejects(client.get("/projects"), /disk full/);
  assert.equal(loginCount, 2);
});

test("a non-401 GET error does not trigger login", async () => {
  let callCount = 0;
  const client = makeClient({
    fetchImpl: async () => {
      callCount += 1;
      return jsonResponse({ message: "forbidden" }, 403);
    },
  });
  await assert.rejects(client.get("/projects"), /HTTP 403/);
  assert.equal(callCount, 1);
});

test("API failure payloads are rejected without triggering login", async (t) => {
  for (const [name, payload] of [
    ["error field", { error: "denied" }],
    ["fail status", { status: "fail", message: "denied" }],
  ]) {
    await t.test(name, async () => {
      let callCount = 0;
      const client = makeClient({
        fetchImpl: async () => {
          callCount += 1;
          return jsonResponse(payload);
        },
      });
      await assert.rejects(client.get("/projects"), /禅道 API 请求失败/);
      assert.equal(callCount, 1);
    });
  }
});

test("GET errors do not expose the token used by the request", async () => {
  const client = makeClient({
    fetchImpl: async () =>
      jsonResponse({ message: "rejected valid-token" }, 403),
  });
  const error = await client.get("/projects").catch((value) => value);
  assert.match(error.message, /禅道 API 请求失败：HTTP 403/);
  assert.doesNotMatch(error.message, /valid-token/);
});

test("login transport errors do not expose credentials", async () => {
  const client = makeClient({
    initialToken: "",
    account: "sensitive-account",
    password: "sensitive-password",
    fetchImpl: async () => {
      throw new Error("network failure for sensitive-account with sensitive-password");
    },
  });
  const error = await client.get("/projects").catch((value) => value);
  assert.match(error.message, /禅道自动登录失败/);
  assert.doesNotMatch(error.message, /sensitive-account|sensitive-password/);
});

test("persistence errors do not expose the fresh token", async () => {
  const client = makeClient({
    initialToken: "",
    persistToken: async (token) => {
      throw new Error(`disk full while saving ${token}`);
    },
    fetchImpl: async () => jsonResponse({ token: "fresh-token" }),
  });
  const error = await client.get("/projects").catch((value) => value);
  assert.match(error.message, /disk full/);
  assert.doesNotMatch(error.message, /fresh-token/);
});

test("GET transport errors do not expose the request token", async () => {
  const client = makeClient({
    fetchImpl: async () => {
      throw new Error("network failure while using valid-token");
    },
  });
  const error = await client.get("/projects").catch((value) => value);
  assert.match(error.message, /network failure/);
  assert.doesNotMatch(error.message, /valid-token/);
});

test("redaction does not leave suffixes from overlapping credentials", async () => {
  const client = makeClient({
    initialToken: "",
    account: "robot",
    password: "robot-secret",
    fetchImpl: async () => {
      throw new Error("network failure for robot-secret");
    },
  });
  const error = await client.get("/projects").catch((value) => value);
  assert.doesNotMatch(error.message, /robot|secret/);
});
