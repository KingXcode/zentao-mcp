import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const startScript = await readFile(path.join(projectDirectory, "start.sh"), "utf8");
const execFile = promisify(execFileCallback);

test("start.sh does not source .env through the shell", () => {
  assert.doesNotMatch(startScript, /^\s*\.\s+.*\.env/m);
});

test("start.sh replaces the shell process with node", () => {
  assert.match(startScript, /\bexec\s+node\b/);
});

test("credential command executes only the fixed Node wizard", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zentao-command-test-"));
  const fakeNodePath = path.join(directory, "node");
  const logPath = path.join(directory, "arguments.log");
  await writeFile(fakeNodePath, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$LOG_PATH\"\n");
  await chmod(fakeNodePath, 0o700);

  try {
    await execFile(path.join(projectDirectory, "scripts", "configure-credentials.command"), {
      env: {
        PATH: `${directory}:${process.env.PATH || ""}`,
        LOG_PATH: logPath,
      },
    });
    assert.equal(
      await readFile(logPath, "utf8"),
      `${path.join(projectDirectory, "scripts", "configure-credentials.mjs")}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
