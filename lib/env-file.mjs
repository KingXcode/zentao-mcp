import { readFile } from "node:fs/promises";

import { atomicReplaceFile } from "./atomic-file.mjs";
import { serializeEnvToken, TOKEN_ENV_ENCODING } from "./token-env-codec.mjs";

export async function updateEnvToken(envPath, token) {
  const original = await readFile(envPath, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const replacement = `ZENTAO_TOKEN=${serializeEnvToken(token)}`;
  const tokenLine = /^((?![ \t]*#)[ \t]*)ZENTAO_TOKEN[ \t]*=[^\r\n]*(\r?)$/m;
  let updated = tokenLine.test(original)
    ? original.replace(tokenLine, (_matchedLine, indentation, carriageReturn) => `${indentation}${replacement}${carriageReturn}`)
    : `${original}${original && !original.endsWith("\n") ? newline : ""}${replacement}${newline}`;
  const encodingReplacement = `ZENTAO_TOKEN_ENCODING=${TOKEN_ENV_ENCODING}`;
  const encodingLine = /^((?![ \t]*#)[ \t]*)ZENTAO_TOKEN_ENCODING[ \t]*=[^\r\n]*(\r?)$/m;
  updated = encodingLine.test(updated)
    ? updated.replace(
      encodingLine,
      (_matchedLine, indentation, carriageReturn) =>
        `${indentation}${encodingReplacement}${carriageReturn}`,
    )
    : `${updated}${updated && !updated.endsWith("\n") ? newline : ""}${encodingReplacement}${newline}`;

  await atomicReplaceFile(envPath, updated);
}
