import { TextDecoder } from "node:util";

const TOKEN_ENCODING_PREFIX = "__ZENTAO_MCP_TOKEN_V1__";
export const TOKEN_ENV_ENCODING = "base64url-v1";
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function invalidEncodedToken() {
  throw new Error("ZENTAO_TOKEN 编码配置无效");
}

export function serializeEnvToken(token) {
  const value = String(token);
  const bytes = Buffer.from(value, "utf8");
  return `"${TOKEN_ENCODING_PREFIX}${bytes.length}.${bytes.toString("base64url")}"`;
}

export function parseEnvToken(value, encoding) {
  const stored = String(value);
  if (encoding !== TOKEN_ENV_ENCODING) return stored;
  if (!stored.startsWith(TOKEN_ENCODING_PREFIX)) invalidEncodedToken();

  const envelope = stored.slice(TOKEN_ENCODING_PREFIX.length);
  const match = /^(0|[1-9]\d*)\.([A-Za-z0-9_-]*)$/.exec(envelope);
  if (!match) invalidEncodedToken();
  const expectedLength = Number(match[1]);
  const encoded = match[2];
  if (!Number.isSafeInteger(expectedLength)) invalidEncodedToken();

  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== expectedLength || bytes.toString("base64url") !== encoded) {
    invalidEncodedToken();
  }
  try {
    const decoded = fatalUtf8Decoder.decode(bytes);
    if (!Buffer.from(decoded, "utf8").equals(bytes)) invalidEncodedToken();
    return decoded;
  } catch {
    invalidEncodedToken();
  }
}
