function buildUrl(baseUrl, apiPrefix, path, query = {}) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${apiPrefix.replace(/\/$/, "")}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

class ZentaoHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class ZentaoRequestFailure extends Error {
  constructor(kind, status) {
    super(kind);
    this.kind = kind;
    this.status = status;
  }
}

async function fetchTextWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    try {
      response = await fetchImpl(url, { ...options, signal: controller.signal });
    } catch {
      throw new ZentaoRequestFailure(controller.signal.aborted ? "timeout" : "request");
    }
    try {
      return { response, text: await response.text() };
    } catch {
      throw new ZentaoRequestFailure(
        controller.signal.aborted ? "timeout" : "body",
        response.status,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function secretRepresentations(secret) {
  const jsonEncoded = JSON.stringify(secret).slice(1, -1);
  const urlEncoded = encodeURIComponent(secret);
  const lowerCaseUrlEncoded = urlEncoded.replace(/%[0-9A-F]{2}/g, (escape) =>
    escape.toLowerCase(),
  );
  const formEncoded = new URLSearchParams([["value", secret]])
    .toString()
    .slice("value=".length);
  return [secret, jsonEncoded, urlEncoded, lowerCaseUrlEncoded, formEncoded];
}

function redactSecrets(value, secrets) {
  let redacted = String(value);
  const orderedRepresentations = [...new Set(secrets)]
    .filter((secret) => typeof secret === "string" && secret)
    .flatMap(secretRepresentations)
    .sort((left, right) => right.length - left.length);
  for (const representation of orderedRepresentations) {
    redacted = redacted.replaceAll(representation, "[已隐藏]");
  }
  return redacted;
}

function redactData(value, secrets) {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactData(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactSecrets(key, secrets),
        redactData(item, secrets),
      ]),
    );
  }
  return value;
}

export function createZentaoClient(options) {
  const {
    baseUrl,
    apiPrefix,
    initialToken,
    account,
    password,
    timeoutMs,
    fetchImpl = globalThis.fetch,
    persistToken,
  } = options;
  let currentToken = initialToken;
  let refreshPromise = null;
  const knownSecrets = new Set([account, password, initialToken].filter(Boolean));

  async function performLogin() {
    if (!account || !password) {
      throw new Error("禅道 Token 不可用，且缺少 ZENTAO_ACCOUNT 或 ZENTAO_PASSWORD");
    }
    let response;
    let text;
    try {
      ({ response, text } = await fetchTextWithTimeout(
        fetchImpl,
        buildUrl(baseUrl, apiPrefix, "/tokens"),
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ account, password }),
        },
        timeoutMs,
      ));
    } catch (error) {
      if (error instanceof ZentaoRequestFailure && error.kind === "timeout") {
        throw new Error("禅道自动登录失败：请求超时");
      }
      if (error instanceof ZentaoRequestFailure && error.kind === "body") {
        throw new Error(`禅道自动登录失败：HTTP ${error.status}，响应读取失败`);
      }
      throw new Error("禅道自动登录失败：请求失败");
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`禅道自动登录失败：HTTP ${response.status}，响应不是 JSON`);
    }
    if (!response.ok) {
      throw new Error(`禅道自动登录失败：HTTP ${response.status}`);
    }
    const freshToken = typeof data?.token === "string" ? data.token.trim() : "";
    if (!freshToken) {
      throw new Error("禅道自动登录失败：响应缺少有效 token");
    }
    knownSecrets.add(freshToken);
    try {
      await persistToken(freshToken);
    } catch {
      throw new Error("禅道 Token 持久化失败");
    }
    currentToken = freshToken;
    return freshToken;
  }

  async function refreshToken() {
    if (!refreshPromise) {
      refreshPromise = performLogin().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  async function requestWithToken(path, query, token) {
    let response;
    let text;
    try {
      ({ response, text } = await fetchTextWithTimeout(
        fetchImpl,
        buildUrl(baseUrl, apiPrefix, path, query),
        {
          method: "GET",
          headers: {
            Token: token,
            Accept: "application/json",
          },
        },
        timeoutMs,
      ));
    } catch (error) {
      if (error instanceof ZentaoRequestFailure && error.status === 401) {
        const detail = error.kind === "timeout" ? "请求超时" : "响应读取失败";
        throw new ZentaoHttpError(401, `禅道 API 请求失败：HTTP 401 ${detail}`);
      }
      if (error instanceof ZentaoRequestFailure && error.kind === "timeout") {
        throw new Error("禅道 API 请求失败：请求超时");
      }
      if (error instanceof ZentaoRequestFailure && error.kind === "body") {
        throw new Error("禅道 API 响应读取失败");
      }
      throw new Error("禅道 API 请求失败：请求失败");
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const message = `禅道返回的不是 JSON：HTTP ${response.status}`;
      if (!response.ok) throw new ZentaoHttpError(response.status, message);
      throw new Error(message);
    }

    if (!response.ok || data?.error || data?.status === "fail") {
      const rawDetail = data?.message || data?.error || "请求失败";
      const unsafeDetail =
        typeof rawDetail === "string" ? rawDetail : JSON.stringify(rawDetail);
      const detail = redactSecrets(unsafeDetail, [...knownSecrets, token, currentToken]);
      throw new ZentaoHttpError(
        response.status,
        `禅道 API 请求失败：HTTP ${response.status} ${detail}`,
      );
    }

    return redactData(data, [...knownSecrets, token, currentToken]);
  }

  async function get(path, query = {}) {
    if (!currentToken) await refreshToken();
    const tokenUsed = currentToken;
    try {
      return await requestWithToken(path, query, tokenUsed);
    } catch (error) {
      if (!(error instanceof ZentaoHttpError) || error.status !== 401) throw error;
      if (refreshPromise) {
        await refreshPromise;
      } else if (currentToken === tokenUsed) {
        await refreshToken();
      }
      return requestWithToken(path, query, currentToken);
    }
  }

  return { get };
}
