import { StringDecoder } from "node:string_decoder";

const CANCELLED_MESSAGE = "已取消禅道凭据配置";
const READ_FAILED_MESSAGE = "读取禅道凭据失败";
const TTY_REQUIRED_MESSAGE = "禅道凭据配置必须在交互式终端中运行";

export function readTtyLine({ input, output, prompt, hidden = false }) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error(TTY_REQUIRED_MESSAGE));
  }

  return new Promise((resolve, reject) => {
    const previousRawMode = Boolean(input.isRaw);
    const decoder = new StringDecoder("utf8");
    let value = "";
    let settled = false;
    const outputHasEvents =
      typeof output.on === "function" && typeof output.removeListener === "function";

    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      if (outputHasEvents) output.removeListener("error", onOutputError);
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      let finalError = error;
      try {
        input.setRawMode(previousRawMode);
      } catch {
        finalError = new Error(READ_FAILED_MESSAGE);
      }
      try {
        output.write("\n");
      } catch {
        finalError ||= new Error(READ_FAILED_MESSAGE);
      }
      if (finalError) reject(finalError);
      else resolve(value);
    };

    const onError = () => finish(new Error(READ_FAILED_MESSAGE));
    const onEnd = () => finish(new Error(READ_FAILED_MESSAGE));
    const onOutputError = () => finish(new Error(READ_FAILED_MESSAGE));
    const onData = (chunk) => {
      try {
        const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        for (const character of text) {
          if (character === "\r" || character === "\n") {
            finish();
            return;
          }
          if (character === "\u0003") {
            finish(new Error(CANCELLED_MESSAGE));
            return;
          }
          if (character === "\u007f" || character === "\b") {
            const characters = Array.from(value);
            if (characters.length > 0) {
              characters.pop();
              value = characters.join("");
              if (!hidden) output.write("\b \b");
            }
            continue;
          }
          value += character;
          if (!hidden) output.write(character);
        }
      } catch {
        finish(new Error(READ_FAILED_MESSAGE));
      }
    };

    try {
      input.on("data", onData);
      input.on("error", onError);
      input.on("end", onEnd);
      input.on("close", onEnd);
      if (outputHasEvents) output.on("error", onOutputError);
      input.setRawMode(true);
      output.write(String(prompt || ""));
      if (!settled) input.resume?.();
    } catch {
      finish(new Error(READ_FAILED_MESSAGE));
    }
  });
}

export async function promptForCredentials({
  readLine = readTtyLine,
  input,
  output,
}) {
  let account = "";
  while (!account.trim()) {
    account = await readLine({
      input,
      output,
      prompt: "禅道账号：",
      hidden: false,
    });
    if (!account.trim()) output.write("账号不能为空。\n");
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const password = await readLine({
      input,
      output,
      prompt: "禅道密码：",
      hidden: true,
    });
    const confirmation = await readLine({
      input,
      output,
      prompt: "再次确认密码：",
      hidden: true,
    });
    if (password && password === confirmation) {
      return { account: account.trim(), password };
    }
    output.write(
      attempt < 3
        ? "密码为空或两次输入不一致，请重试。\n"
        : "密码确认失败，未修改配置。\n",
    );
  }

  throw new Error("密码确认失败，未修改配置");
}
