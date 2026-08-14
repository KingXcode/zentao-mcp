function buildUrl(baseUrl, apiPrefix, path, query = {}) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${apiPrefix.replace(/\/$/, "")}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class ZentaoHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function redactSecrets(value, secrets) {
  let redacted = String(value);
  const orderedSecrets = [...new Set(secrets)]
    .filter((secret) => typeof secret === "string" && secret)
    .sort((left, right) => right.length - left.length);
  for (const secret of orderedSecrets) {
    redacted = redacted.replaceAll(secret, "[已隐藏]");
  }
  return redacted;
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

  async function performLogin() {
    if (!account || !password) {
      throw new Error("禅道 Token 不可用，且缺少 ZENTAO_ACCOUNT 或 ZENTAO_PASSWORD");
    }
    let response;
    try {
      response = await fetchWithTimeout(
        fetchImpl,
        buildUrl(baseUrl, apiPrefix, "/tokens"),
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ account, password }),
        },
        timeoutMs,
      );
    } catch (error) {
      const detail = redactSecrets(messageOf(error), [account, password, currentToken]);
      throw new Error(`禅道自动登录失败：${detail}`);
    }
    let data;
    try {
      data = JSON.parse(await response.text());
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
    try {
      await persistToken(freshToken);
    } catch (error) {
      throw new Error(
        redactSecrets(messageOf(error), [account, password, currentToken, freshToken]),
      );
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
    try {
      response = await fetchWithTimeout(
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
      );
    } catch (error) {
      throw new Error(redactSecrets(messageOf(error), [account, password, token, currentToken]));
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const message = `禅道返回的不是 JSON：HTTP ${response.status}`;
      if (!response.ok) throw new ZentaoHttpError(response.status, message);
      throw new Error(message);
    }

    if (!response.ok || data?.error || data?.status === "fail") {
      const rawDetail = data?.message || data?.error || response.statusText;
      const unsafeDetail =
        typeof rawDetail === "string" ? rawDetail : JSON.stringify(rawDetail);
      const detail = redactSecrets(unsafeDetail, [account, password, token, currentToken]);
      throw new ZentaoHttpError(
        response.status,
        `禅道 API 请求失败：HTTP ${response.status} ${detail}`,
      );
    }

    return data;
  }

  async function get(path, query = {}) {
    if (!currentToken) await refreshToken();
    const tokenUsed = currentToken;
    try {
      return await requestWithToken(path, query, tokenUsed);
    } catch (error) {
      if (error.status !== 401) throw error;
      if (currentToken === tokenUsed) await refreshToken();
      return requestWithToken(path, query, currentToken);
    }
  }

  return { get };
}
