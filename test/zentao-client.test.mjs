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

test("a delayed old-token 401 waits for an in-flight newer refresh", async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((promiseResolve) => {
      resolve = promiseResolve;
    });
    return { promise, resolve };
  };
  const oldRequestStarted = deferred();
  const releaseOldResponse = deferred();
  const secondLoginStarted = deferred();
  const releaseSecondLogin = deferred();
  const oldRequestTokens = [];
  let loginCount = 0;

  const client = makeClient({
    fetchImpl: async (url, options) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/tokens")) {
        loginCount += 1;
        if (loginCount === 1) return jsonResponse({ token: "token-one" });
        secondLoginStarted.resolve();
        await releaseSecondLogin.promise;
        return jsonResponse({ token: "token-two" });
      }
      if (requestUrl.endsWith("/old")) {
        oldRequestTokens.push(options.headers.Token);
        if (options.headers.Token === "valid-token") {
          oldRequestStarted.resolve();
          await releaseOldResponse.promise;
          return jsonResponse({ message: "expired" }, 401);
        }
        return options.headers.Token === "token-two"
          ? jsonResponse({ generation: 2 })
          : jsonResponse({ message: "expired" }, 401);
      }
      if (requestUrl.endsWith("/advance")) {
        return options.headers.Token === "valid-token"
          ? jsonResponse({ message: "expired" }, 401)
          : jsonResponse({ generation: 1 });
      }
      if (requestUrl.endsWith("/refresh")) {
        return options.headers.Token === "token-one"
          ? jsonResponse({ message: "expired" }, 401)
          : jsonResponse({ generation: 2 });
      }
      throw new Error("unexpected test URL");
    },
  });

  const oldOutcomePromise = client.get("/old").then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await oldRequestStarted.promise;
  assert.deepEqual(await client.get("/advance"), { generation: 1 });
  const refreshPromise = client.get("/refresh");
  await secondLoginStarted.promise;
  releaseOldResponse.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  releaseSecondLogin.resolve();

  const [oldOutcome, refreshResult] = await Promise.all([oldOutcomePromise, refreshPromise]);
  assert.equal(oldOutcome.error, undefined);
  assert.deepEqual(oldOutcome.value, { generation: 2 });
  assert.deepEqual(refreshResult, { generation: 2 });
  assert.deepEqual(oldRequestTokens, ["valid-token", "token-two"]);
  assert.equal(loginCount, 2);
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
  await assert.rejects(client.get("/projects"), /禅道 Token 持久化失败/);
  await assert.rejects(client.get("/projects"), /禅道 Token 持久化失败/);
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
  assert.equal(error.message, "禅道 Token 持久化失败");
  assert.doesNotMatch(error.message, /fresh-token/);
});

test("GET transport errors do not expose the request token", async () => {
  const client = makeClient({
    fetchImpl: async () => {
      throw new Error("network failure while using valid-token");
    },
  });
  const error = await client.get("/projects").catch((value) => value);
  assert.equal(error.message, "禅道 API 请求失败：请求失败");
  assert.doesNotMatch(error.message, /valid-token/);
});

test("GET body read errors use a fixed safe message", async () => {
  const client = makeClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => {
        throw new Error("body failed for valid-token and secret-password");
      },
    }),
  });
  const error = await client.get("/projects").catch((value) => value);
  assert.equal(error.message, "禅道 API 响应读取失败");
  assert.doesNotMatch(error.message, /valid-token|secret-password/);
});

test("an arbitrary body error with status 401 does not trigger login", async () => {
  let loginCount = 0;
  const client = makeClient({
    fetchImpl: async (url) => {
      if (String(url).endsWith("/tokens")) {
        loginCount += 1;
        return jsonResponse({ token: "fresh-token" });
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => {
          throw Object.assign(new Error("not an HTTP response error"), { status: 401 });
        },
      };
    },
  });
  await assert.rejects(client.get("/projects"), /禅道 API 响应读取失败/);
  assert.equal(loginCount, 0);
});

test("an HTTP 401 body read failure refreshes and retries once", async () => {
  let loginCount = 0;
  let getCount = 0;
  const client = makeClient({
    fetchImpl: async (url) => {
      if (String(url).endsWith("/tokens")) {
        loginCount += 1;
        return jsonResponse({ token: "fresh-token" });
      }
      getCount += 1;
      if (getCount === 1) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: async () => {
            throw new Error("body failed for valid-token");
          },
        };
      }
      return jsonResponse({ ok: true });
    },
  });

  assert.deepEqual(await client.get("/projects"), { ok: true });
  assert.equal(loginCount, 1);
  assert.equal(getCount, 2);
});

test("successful GET results recursively redact known authentication values", async () => {
  const client = makeClient({
    fetchImpl: async () =>
      jsonResponse({
        direct: "valid-token",
        nested: {
          account: "robot",
          password: "prefix secret-password suffix",
        },
        array: ["valid-token", { value: "secret-password" }],
        "key-valid-token": "visible",
        safe: 42,
      }),
  });

  const result = await client.get("/projects");
  assert.doesNotMatch(JSON.stringify(result), /valid-token|robot|secret-password/);
  assert.equal(result.safe, 42);
  assert.equal(result["key-[已隐藏]"], "visible");
});

test("successful GET results redact a freshly logged-in token", async () => {
  const client = makeClient({
    initialToken: "",
    fetchImpl: async (url) =>
      String(url).endsWith("/tokens")
        ? jsonResponse({ token: "fresh-token" })
        : jsonResponse({ nested: [{ credential: "fresh-token" }], safe: true }),
  });

  const result = await client.get("/projects");
  assert.doesNotMatch(JSON.stringify(result), /fresh-token/);
  assert.equal(result.safe, true);
});

test("bottom-layer failures use fixed messages for encoded credentials", async (t) => {
  const password = 'sensitive"password\\part';
  const token = 'sensitive"token\\part';

  await t.test("login transport", async () => {
    const encodedPassword = JSON.stringify(password).slice(1, -1);
    const client = makeClient({
      initialToken: "",
      password,
      fetchImpl: async () => {
        throw new Error(`network failure for ${encodedPassword}`);
      },
    });
    const error = await client.get("/projects").catch((value) => value);
    assert.equal(error.message, "禅道自动登录失败：请求失败");
    assert.equal(error.message.includes(encodedPassword), false);
  });

  await t.test("persistence", async () => {
    const encodedToken = encodeURIComponent(token);
    const client = makeClient({
      initialToken: "",
      persistToken: async () => {
        throw new Error(`disk failure for ${encodedToken}`);
      },
      fetchImpl: async () => jsonResponse({ token }),
    });
    const error = await client.get("/projects").catch((value) => value);
    assert.equal(error.message, "禅道 Token 持久化失败");
    assert.equal(error.message.includes(encodedToken), false);
  });

  await t.test("GET transport", async () => {
    const encodedToken = JSON.stringify(token).slice(1, -1);
    const client = makeClient({
      initialToken: token,
      fetchImpl: async () => {
        throw new Error(`network failure for ${encodedToken}`);
      },
    });
    const error = await client.get("/projects").catch((value) => value);
    assert.equal(error.message, "禅道 API 请求失败：请求失败");
    assert.equal(error.message.includes(encodedToken), false);
  });
});

test("API errors redact URL-encoded authentication values", async () => {
  const token = 'sensitive"token\\part';
  const encodedToken = encodeURIComponent(token);
  const client = makeClient({
    initialToken: token,
    fetchImpl: async () =>
      jsonResponse({ message: `rejected ${encodedToken}` }, 403),
  });
  const error = await client.get("/projects").catch((value) => value);
  assert.match(error.message, /HTTP 403/);
  assert.equal(error.message.includes(encodedToken), false);
});

test("API errors redact tokens from earlier refresh generations", async () => {
  let loginCount = 0;
  const pathAttempts = new Map();
  const client = makeClient({
    fetchImpl: async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/tokens")) {
        loginCount += 1;
        return jsonResponse({ token: `token-${loginCount}` });
      }
      if (requestUrl.endsWith("/error")) {
        return jsonResponse({ message: "rejected token-1" }, 403);
      }
      const attempts = (pathAttempts.get(requestUrl) || 0) + 1;
      pathAttempts.set(requestUrl, attempts);
      return attempts === 1
        ? jsonResponse({ message: "expired" }, 401)
        : jsonResponse({ ok: true });
    },
  });

  await client.get("/first-refresh");
  await client.get("/second-refresh");
  const error = await client.get("/error").catch((value) => value);
  assert.match(error.message, /HTTP 403/);
  assert.doesNotMatch(error.message, /token-1/);
});

test("successful GET results redact encoded authentication values", async () => {
  const password = 'sensitive"password\\part';
  const token = 'sensitive"token\\part';
  const jsonEncodedPassword = JSON.stringify(password).slice(1, -1);
  const urlEncodedToken = encodeURIComponent(token);
  const client = makeClient({
    initialToken: token,
    password,
    fetchImpl: async () =>
      jsonResponse({ nested: [jsonEncodedPassword, { token: urlEncodedToken }], safe: true }),
  });

  const result = await client.get("/projects");
  assert.equal(result.nested[0], "[已隐藏]");
  assert.equal(result.nested[1].token, "[已隐藏]");
  assert.equal(JSON.stringify(result).includes(jsonEncodedPassword), false);
  assert.equal(JSON.stringify(result).includes(urlEncodedToken), false);
  assert.equal(result.safe, true);
});

test("GET timeout covers reading the response body", async () => {
  let bodyStarted = false;
  const client = makeClient({
    timeoutMs: 0,
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => {
        bodyStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (options.signal.aborted) {
          throw new Error("body timeout for valid-token");
        }
        return JSON.stringify({ ok: true });
      },
    }),
  });

  await assert.rejects(client.get("/projects"), {
    message: "禅道 API 请求失败：请求超时",
  });
  assert.equal(bodyStarted, true);
});

test("login timeout covers reading the response body", async () => {
  let loginBodyStarted = false;
  const client = makeClient({
    initialToken: "",
    timeoutMs: 0,
    fetchImpl: async (url, options) => {
      if (!String(url).endsWith("/tokens")) return jsonResponse({ ok: true });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => {
          loginBodyStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (options.signal.aborted) {
            throw new Error("body timeout for secret-password");
          }
          return JSON.stringify({ token: "fresh-token" });
        },
      };
    },
  });

  await assert.rejects(client.get("/projects"), {
    message: "禅道自动登录失败：请求超时",
  });
  assert.equal(loginBodyStarted, true);
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
