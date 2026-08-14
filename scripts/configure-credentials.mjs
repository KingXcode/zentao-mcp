import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { updateEnvCredentials } from "../lib/env-credentials.mjs";
import { promptForCredentials, readTtyLine } from "../lib/terminal-input.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);
const defaultEnvPath = path.join(projectDirectory, ".env");

async function defaultWaitForEnter({ input, output }) {
  await readTtyLine({
    input,
    output,
    prompt: "按回车关闭此窗口。",
    hidden: true,
  });
}

export async function runCredentialWizard({
  envPath = defaultEnvPath,
  input = process.stdin,
  output = process.stdout,
  promptImpl = promptForCredentials,
  persistImpl = updateEnvCredentials,
  waitForEnter = defaultWaitForEnter,
} = {}) {
  const credentials = await promptImpl({ input, output });
  try {
    await persistImpl(envPath, credentials);
  } catch {
    output.write("保存禅道账号密码失败。\n");
    throw new Error("保存禅道账号密码失败");
  }
  output.write("禅道账号密码已保存。返回 Codex 后请重新调用原工具。\n");
  await waitForEnter({ input, output });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCredentialWizard().catch(() => {
    process.exitCode = 1;
  });
}
