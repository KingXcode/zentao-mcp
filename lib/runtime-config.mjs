import path from "node:path";

import { config as loadEnv } from "dotenv";

export function loadRuntimeConfig(envPath) {
  const envResult = loadEnv({ path: envPath, quiet: true, processEnv: {} });
  if (envResult.error) throw new Error(`无法加载 ${envPath}：${envResult.error.message}`);
  const values = envResult.parsed || {};
  const baseUrl = values.ZENTAO_BASE_URL?.trim();
  if (!baseUrl) throw new Error("缺少环境变量 ZENTAO_BASE_URL");
  return {
    envPath: path.resolve(envPath),
    baseUrl,
    apiPrefix: values.ZENTAO_API_PREFIX?.trim() || "/api.php/v1",
    initialToken: values.ZENTAO_TOKEN?.trim() || "",
    account: values.ZENTAO_ACCOUNT?.trim() || "",
    password: values.ZENTAO_PASSWORD || "",
    timeoutMs: Number(values.ZENTAO_TIMEOUT_MS || 15000),
  };
}
