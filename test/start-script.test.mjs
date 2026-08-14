import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const startScript = await readFile(path.join(projectDirectory, "start.sh"), "utf8");

test("start.sh does not source .env through the shell", () => {
  assert.doesNotMatch(startScript, /^\s*\.\s+.*\.env/m);
});

test("start.sh replaces the shell process with node", () => {
  assert.match(startScript, /\bexec\s+node\b/);
});
