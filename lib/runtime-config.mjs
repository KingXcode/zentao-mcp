import path from "node:path";

import { config as loadEnv } from "dotenv";

import { parseEnvToken } from "./token-env-codec.mjs";

export function loadRuntimeConfig(envPath) {
  const envResult = loadEnv({ path: envPath, quiet: true, processEnv: {} });
  if (envResult.error) throw new Error(`无法加载 ${envPath}：${envResult.error.message}`);
  const values = envResult.parsed || {};
  const baseUrl = values.ZENTAO_BASE_URL?.trim();
  if (!baseUrl) throw new Error("缺少环境变量 ZENTAO_BASE_URL");
  const timeoutMs = Number(values.ZENTAO_TIMEOUT_MS || 15000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("ZENTAO_TIMEOUT_MS 必须是有限的正数");
  }
  return {
    envPath: path.resolve(envPath),
    baseUrl,
    apiPrefix: values.ZENTAO_API_PREFIX?.trim() || "/api.php/v1",
    initialToken: parseEnvToken(
      values.ZENTAO_TOKEN?.trim() || "",
      values.ZENTAO_TOKEN_ENCODING?.trim(),
    ),
    account: values.ZENTAO_ACCOUNT?.trim() || "",
    password: values.ZENTAO_PASSWORD || "",
    timeoutMs,
  };
}
