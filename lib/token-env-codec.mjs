const TOKEN_ENCODING_PREFIX = "__ZENTAO_MCP_TOKEN_V1__";
export const TOKEN_ENV_ENCODING = "base64url-v1";

export function serializeEnvToken(token) {
  const value = String(token);
  const bytes = Buffer.from(value, "utf8");
  return `"${TOKEN_ENCODING_PREFIX}${bytes.length}.${bytes.toString("base64url")}"`;
}

export function parseEnvToken(value, encoding) {
  const stored = String(value);
  if (encoding !== TOKEN_ENV_ENCODING) return stored;
  if (!stored.startsWith(TOKEN_ENCODING_PREFIX)) return stored;

  const envelope = stored.slice(TOKEN_ENCODING_PREFIX.length);
  const separator = envelope.indexOf(".");
  if (separator <= 0) return stored;
  const expectedLength = Number(envelope.slice(0, separator));
  const encoded = envelope.slice(separator + 1);
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) return stored;
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return stored;

  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== expectedLength || bytes.toString("base64url") !== encoded) {
    return stored;
  }
  return bytes.toString("utf8");
}
