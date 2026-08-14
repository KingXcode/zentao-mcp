import assert from "node:assert/strict";
import test from "node:test";

import { createMcpOutput, plainText } from "../lib/mcp-output.mjs";
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
    account: "2468",
    password: "p&x",
    timeoutMs: 1000,
    persistToken: async () => {},
    ...overrides,
  });
}

test("final MCP output redacts secrets reconstructed by business mapping", async () => {
  const client = makeClient({
    fetchImpl: async () =>
      jsonResponse({
        steps: "password p&amp;x",
        untouchedHtml: "encoded password p&amp;x",
        numericAccount: 2468,
        safe: "visible",
      }),
  });
  const data = await client.get("/bugs/1");
  const mapped = {
    steps: plainText(data.steps),
    untouchedHtml: data.untouchedHtml,
    account: String(data.numericAccount),
    safe: data.safe,
  };
  const { ok } = createMcpOutput(client.redactOutbound, client.containsOutboundSecret);

  const result = ok(mapped);

  assert.equal(result.content[0].type, "text");
  assert.doesNotMatch(result.content[0].text, /p&x|p&amp;x|2468/);
  assert.match(result.content[0].text, /\[已隐藏\]/);
  assert.match(result.content[0].text, /visible/);
});

test("final MCP output redacts secrets from error content", () => {
  const client = makeClient({ fetchImpl: async () => jsonResponse({ ok: true }) });
  const { fail } = createMcpOutput(client.redactOutbound, client.containsOutboundSecret);

  const result = fail(new Error("failed for p&amp;x and 2468"));

  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /p&x|p&amp;x|2468/);
  assert.match(result.content[0].text, /\[已隐藏\]/);
});

test("final MCP output redacts secrets reconstructed by JSON string escaping", async () => {
  const password = "token\\nwith\\nliterals";
  const client = makeClient({
    password,
    fetchImpl: async () => jsonResponse({ note: "token\nwith\nliterals", safe: "visible" }),
  });
  const { ok } = createMcpOutput(client.redactOutbound, client.containsOutboundSecret);

  const result = ok(await client.get("/projects"));

  assert.equal(result.content[0].text.includes(password), false);
  assert.match(result.content[0].text, /\[已隐藏\]/);
  assert.match(result.content[0].text, /visible/);
});

test("final MCP output redacts encoded secret representations", async () => {
  const password = 'p&x"\\tail';
  const token = "x y+z}";
  const jsonEncodedPassword = JSON.stringify(password).slice(1, -1);
  const urlEncodedToken = encodeURIComponent(token);
  const formEncodedToken = new URLSearchParams([["value", token]])
    .toString()
    .slice("value=".length);
  const client = makeClient({
    initialToken: token,
    password,
    fetchImpl: async () =>
      jsonResponse({
        jsonEncodedPassword,
        urlEncodedToken,
        formEncodedToken,
        safe: "visible",
      }),
  });
  const { ok } = createMcpOutput(client.redactOutbound, client.containsOutboundSecret);

  const result = ok(await client.get("/projects"));

  assert.doesNotMatch(
    result.content[0].text,
    new RegExp(
      [jsonEncodedPassword, urlEncodedToken, formEncodedToken]
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
    ),
  );
  assert.match(result.content[0].text, /visible/);
});

test("final MCP output redacts tokens from every refresh generation", async () => {
  let loginCount = 0;
  const getAttempts = new Map();
  const client = makeClient({
    fetchImpl: async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/tokens")) {
        loginCount += 1;
        return jsonResponse({ token: `token-${loginCount}` });
      }
      if (requestUrl.endsWith("/leak")) {
        return jsonResponse({ note: "historical token-1" });
      }
      const attempts = (getAttempts.get(requestUrl) || 0) + 1;
      getAttempts.set(requestUrl, attempts);
      return attempts === 1 ? jsonResponse({ message: "expired" }, 401) : jsonResponse({ ok: true });
    },
  });

  await client.get("/first-refresh");
  await client.get("/second-refresh");
  const data = await client.get("/leak");
  const { ok } = createMcpOutput(client.redactOutbound, client.containsOutboundSecret);

  const result = ok(data);

  assert.equal(loginCount, 2);
  assert.doesNotMatch(result.content[0].text, /token-1/);
  assert.match(result.content[0].text, /historical \[已隐藏\]/);
});
