import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

function encodeDotenvValue(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;
}

export async function updateEnvToken(envPath, token) {
  const original = await readFile(envPath, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const replacement = `ZENTAO_TOKEN=${encodeDotenvValue(token)}`;
  const tokenLine = /^(?!\s*#)\s*ZENTAO_TOKEN\s*=[^\r\n]*$/m;
  const updated = tokenLine.test(original)
    ? original.replace(tokenLine, (matchedLine) => `${matchedLine.startsWith("\n") ? "\n" : ""}${replacement}`)
    : `${original}${original && !original.endsWith("\n") ? newline : ""}${replacement}${newline}`;
  const temporaryPath = path.join(path.dirname(envPath), `.${path.basename(envPath)}.${randomUUID()}.tmp`);

  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(updated, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, envPath);
    await chmod(envPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
