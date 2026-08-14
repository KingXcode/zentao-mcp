import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { atomicReplaceFile } from "../lib/atomic-file.mjs";

async function withTargetFile(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "zentao-atomic-file-test-"));
  const targetPath = path.join(directory, ".env");
  await writeFile(targetPath, "old", { mode: 0o600 });
  try {
    await run(targetPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function recordingOpen(events, override = {}) {
  return async (...args) => {
    const handle = await open(...args);
    return {
      async writeFile(...writeArgs) {
        events.push("write");
        return handle.writeFile(...writeArgs);
      },
      async chmod(...chmodArgs) {
        events.push("chmod");
        return handle.chmod(...chmodArgs);
      },
      async stat(...statArgs) {
        events.push("stat");
        return handle.stat(...statArgs);
      },
      async sync(...syncArgs) {
        events.push("sync");
        if (override.sync) return override.sync();
        return handle.sync(...syncArgs);
      },
      async close(...closeArgs) {
        events.push("close");
        return handle.close(...closeArgs);
      },
    };
  };
}

test("atomicReplaceFile makes rename the final successful operation", async () => {
  await withTargetFile(async (targetPath) => {
    const events = [];

    await atomicReplaceFile(targetPath, "new", {
      openFile: recordingOpen(events),
      renameFile: async (...args) => {
        events.push("rename");
        return rename(...args);
      },
      removeFile: async () => {
        events.push("cleanup");
        throw new Error("cleanup must not run after commit");
      },
    });

    assert.equal(await readFile(targetPath, "utf8"), "new");
    assert.deepEqual(events, ["write", "chmod", "stat", "sync", "close", "rename"]);
  });
});

test("atomicReplaceFile keeps the target unchanged when pre-commit sync fails", async () => {
  await withTargetFile(async (targetPath) => {
    const events = [];

    await assert.rejects(
      atomicReplaceFile(targetPath, "new", {
        openFile: recordingOpen(events, {
          sync: async () => {
            throw new Error("injected sync failure");
          },
        }),
        renameFile: async (...args) => {
          events.push("rename");
          return rename(...args);
        },
        removeFile: async (...args) => {
          events.push("cleanup");
          return rm(...args);
        },
      }),
      /injected sync failure/,
    );

    assert.equal(await readFile(targetPath, "utf8"), "old");
    assert.deepEqual(events, ["write", "chmod", "stat", "sync", "close", "cleanup"]);
  });
});
