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

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the fixed public error while still making a best effort to release the body.
  }
}

async function readBytesWithLimit(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBody(response);
    throw new Error(`禅道文件超过 ${maxBytes} 字节限制`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error(`禅道文件超过 ${maxBytes} 字节限制`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function secretRepresentations(secret) {
  const jsonEncoded = JSON.stringify(secret).slice(1, -1);
  const urlEncoded = encodeURIComponent(secret);
  const formEncoded = new URLSearchParams([["value", secret]])
    .toString()
    .slice("value=".length);
  const htmlEncoded = secret
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const representations = [
    { value: secret, pattern: "literal" },
    { value: jsonEncoded, pattern: "literal" },
    { value: urlEncoded, pattern: "percent" },
    { value: formEncoded, pattern: "percent" },
  ];
  if (htmlEncoded !== secret) {
    representations.push({ value: htmlEncoded, pattern: "html" });
  }
  return representations;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function percentEscapeRegExp(value) {
  const hexCharacterPattern = (character) => {
    const lowerCase = character.toLowerCase();
    return /[a-f]/.test(lowerCase)
      ? `[${lowerCase}${lowerCase.toUpperCase()}]`
      : character;
  };
  let source = "";
  let previousIndex = 0;
  for (const match of value.matchAll(/%[0-9A-Fa-f]{2}/g)) {
    source += escapeRegExp(value.slice(previousIndex, match.index));
    source += `%${hexCharacterPattern(match[0][1])}${hexCharacterPattern(match[0][2])}`;
    previousIndex = match.index + match[0].length;
  }
  source += escapeRegExp(value.slice(previousIndex));
  return new RegExp(source, "g");
}

function htmlEscapeRegExp(value) {
  let source = "";
  let previousIndex = 0;
  for (const match of value.matchAll(/&(?:amp|lt|gt|quot|#39);/gi)) {
    source += escapeRegExp(value.slice(previousIndex, match.index));
    source += [...match[0]]
      .map((character) => {
        const lowerCase = character.toLowerCase();
        return /[a-z]/.test(lowerCase)
          ? `[${lowerCase}${lowerCase.toUpperCase()}]`
          : escapeRegExp(character);
      })
      .join("");
    previousIndex = match.index + match[0].length;
  }
  source += escapeRegExp(value.slice(previousIndex));
  return new RegExp(source, "g");
}

function orderedSecretRepresentations(secrets) {
  return [...new Set(secrets)]
    .filter((secret) => typeof secret === "string" && secret)
    .flatMap(secretRepresentations)
    .sort((left, right) => right.value.length - left.value.length);
}

function representationRegExp(representation) {
  if (representation.pattern === "percent") {
    return percentEscapeRegExp(representation.value);
  }
  if (representation.pattern === "html") {
    return htmlEscapeRegExp(representation.value);
  }
  return null;
}

function containsSecrets(value, secrets) {
  const text = String(value);
  return orderedSecretRepresentations(secrets).some((representation) => {
    const pattern = representationRegExp(representation);
    return pattern ? pattern.test(text) : text.includes(representation.value);
  });
}

function redactSecrets(value, secrets) {
  let redacted = String(value);
  const orderedRepresentations = orderedSecretRepresentations(secrets);
  for (const representation of orderedRepresentations) {
    const pattern = representationRegExp(representation);
    if (pattern) {
      redacted = redacted.replace(pattern, "[已隐藏]");
    } else {
      redacted = redacted.replaceAll(representation.value, "[已隐藏]");
    }
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
    loadCredentials,
    onCredentialsRequired,
  } = options;
  let currentToken = initialToken;
  let refreshPromise = null;
  const knownSecrets = new Set([account, password, initialToken].filter(Boolean));
  const credentialProvider = loadCredentials || (() => ({ account, password }));
  const credentialsRequired = onCredentialsRequired || (async () => {});

  async function performLogin() {
    const credentials = await credentialProvider();
    const loginAccount = typeof credentials?.account === "string" ? credentials.account : "";
    const loginPassword = typeof credentials?.password === "string" ? credentials.password : "";
    if (loginAccount) knownSecrets.add(loginAccount);
    if (loginPassword) knownSecrets.add(loginPassword);
    if (!loginAccount || !loginPassword) {
      await credentialsRequired();
      throw new Error("已打开禅道凭据配置终端；填写并保存后请重新调用");
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
          body: JSON.stringify({ account: loginAccount, password: loginPassword }),
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

    return data;
  }

  async function requestBinaryWithToken(path, token, maxBytes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      try {
        response = await fetchImpl(
          buildUrl(baseUrl, apiPrefix, path),
          {
            method: "GET",
            headers: { Token: token, Accept: "application/octet-stream,image/*" },
            redirect: "error",
            signal: controller.signal,
          },
        );
      } catch {
        throw new Error(controller.signal.aborted ? "禅道文件读取失败：请求超时" : "禅道文件读取失败：请求失败");
      }
      if (response.status === 401) {
        await cancelResponseBody(response);
        throw new ZentaoHttpError(401, "禅道文件读取失败：HTTP 401");
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`禅道文件读取失败：HTTP ${response.status}`);
      }
      let bytes;
      try {
        bytes = await readBytesWithLimit(response, maxBytes);
      } catch (error) {
        if (error?.message?.startsWith("禅道文件超过 ")) throw error;
        throw new Error(controller.signal.aborted ? "禅道文件读取失败：请求超时" : "禅道文件读取失败：响应读取失败");
      }
      return {
        bytes,
        contentType: redactSecrets(
          response.headers.get("content-type") || "",
          [...knownSecrets, token, currentToken],
        ),
        contentDisposition: redactSecrets(
          response.headers.get("content-disposition") || "",
          [...knownSecrets, token, currentToken],
        ),
      };
    } finally {
      clearTimeout(timer);
    }
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

  async function getBinary(path, { maxBytes = 5 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes 必须是正整数");
    }
    if (!currentToken) await refreshToken();
    const tokenUsed = currentToken;
    try {
      return await requestBinaryWithToken(path, tokenUsed, maxBytes);
    } catch (error) {
      if (!(error instanceof ZentaoHttpError) || error.status !== 401) throw error;
      if (refreshPromise) {
        await refreshPromise;
      } else if (currentToken === tokenUsed) {
        await refreshToken();
      }
      return requestBinaryWithToken(path, currentToken, maxBytes);
    }
  }

  const outboundSecrets = () => [...knownSecrets, currentToken];
  const redactOutbound = (value) => redactSecrets(value, outboundSecrets());
  const containsOutboundSecret = (value) => containsSecrets(value, outboundSecrets());

  return { get, getBinary, redactOutbound, containsOutboundSecret };
}
