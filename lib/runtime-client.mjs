import { createCredentialWizardLauncher } from "./credential-wizard.mjs";
import { updateEnvToken } from "./env-file.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { createZentaoClient } from "./zentao-client.mjs";

export function createRuntimeClient({
  envPath,
  launcherPath,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  spawnImpl,
}) {
  const runtimeConfig = loadRuntimeConfig(envPath);
  const launcher = createCredentialWizardLauncher({
    launcherPath,
    platform,
    spawnImpl,
  });

  return createZentaoClient({
    ...runtimeConfig,
    fetchImpl,
    persistToken: (token) => updateEnvToken(envPath, token),
    loadCredentials: () => {
      const latestConfig = loadRuntimeConfig(envPath);
      if (latestConfig.account && latestConfig.password) launcher.markConfigured();
      return {
        account: latestConfig.account,
        password: latestConfig.password,
      };
    },
    onCredentialsRequired: () => launcher.open(),
  });
}
