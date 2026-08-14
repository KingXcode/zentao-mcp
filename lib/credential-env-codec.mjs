import { TextDecoder } from "node:util";

const CREDENTIAL_ENCODING_PREFIX = "__ZENTAO_MCP_CREDENTIAL_V1__";
export const CREDENTIAL_ENV_ENCODING = "base64url-v1";
const fatalUtf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

function invalidEncodedCredential() {
  throw new Error("禅道凭据编码配置无效");
}
export function serializeEnvCredential(value) {
  const bytes = Buffer.from(String(value), "utf8");
  return `"${CREDENTIAL_ENCODING_PREFIX}${bytes.length}.${bytes.toString("base64url")}"`;
}

export function parseEnvCredential(value, encoding) {
  const stored = String(value);
  if (encoding !== CREDENTIAL_ENV_ENCODING) return stored;
  if (!stored.startsWith(CREDENTIAL_ENCODING_PREFIX)) invalidEncodedCredential();

  const envelope = stored.slice(CREDENTIAL_ENCODING_PREFIX.length);
  const match = /^(0|[1-9]\d*)\.([A-Za-z0-9_-]*)$/.exec(envelope);
  if (!match) invalidEncodedCredential();
  const expectedLength = Number(match[1]);
  const encoded = match[2];
  if (!Number.isSafeInteger(expectedLength)) invalidEncodedCredential();

  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== expectedLength || bytes.toString("base64url") !== encoded) {
    invalidEncodedCredential();
  }
  try {
    const decoded = fatalUtf8Decoder.decode(bytes);
    if (!Buffer.from(decoded, "utf8").equals(bytes)) invalidEncodedCredential();
    return decoded;
  } catch {
    invalidEncodedCredential();
  }
}
