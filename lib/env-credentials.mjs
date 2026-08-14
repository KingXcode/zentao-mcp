import { readFile } from "node:fs/promises";

import { atomicReplaceFile } from "./atomic-file.mjs";
import {
  CREDENTIAL_ENV_ENCODING,
  serializeEnvCredential,
} from "./credential-env-codec.mjs";

function replaceOrAppend(original, name, value, newline) {
  const replacement = `${name}=${value}`;
  const line = new RegExp(
    `^((?![ \\t]*#)[ \\t]*)${name}[ \\t]*=[^\\r\\n]*(\\r?)$`,
    "m",
  );
  if (line.test(original)) {
    return original.replace(
      line,
      (_matchedLine, indentation, carriageReturn) =>
        `${indentation}${replacement}${carriageReturn}`,
    );
  }
  return `${original}${original && !original.endsWith("\n") ? newline : ""}${replacement}${newline}`;
}
export async function updateEnvCredentials(envPath, { account, password }) {
  const original = await readFile(envPath, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const replacements = [
    ["ZENTAO_ACCOUNT", serializeEnvCredential(account)],
    ["ZENTAO_ACCOUNT_ENCODING", CREDENTIAL_ENV_ENCODING],
    ["ZENTAO_PASSWORD", serializeEnvCredential(password)],
    ["ZENTAO_PASSWORD_ENCODING", CREDENTIAL_ENV_ENCODING],
  ];
  const updated = replacements.reduce(
    (content, [name, value]) => replaceOrAppend(content, name, value, newline),
    original,
  );
  await atomicReplaceFile(envPath, updated);
}
