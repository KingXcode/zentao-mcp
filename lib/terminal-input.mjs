import { StringDecoder } from "node:string_decoder";

const CANCELLED_MESSAGE = "已取消禅道凭据配置";
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

    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      try {
        input.setRawMode(previousRawMode);
      } catch (restoreError) {
        error ||= restoreError;
      }
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    const onError = () => finish(new Error("读取禅道凭据失败"));
    const onData = (chunk) => {
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
    };

    try {
      input.setRawMode(true);
      output.write(String(prompt || ""));
      input.on("data", onData);
      input.on("error", onError);
      input.resume?.();
    } catch {
      finish(new Error("读取禅道凭据失败"));
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
