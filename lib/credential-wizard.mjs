import { spawn } from "node:child_process";

const OPEN_FAILED_MESSAGE = "无法打开禅道凭据配置终端";
const UNSUPPORTED_MESSAGE = "当前平台不支持自动打开禅道凭据配置终端";

export function createCredentialWizardLauncher({
  launcherPath,
  platform = process.platform,
  spawnImpl = spawn,
}) {
  let opened = false;
  let openingPromise = null;

  async function openOnce() {
    if (platform !== "darwin") {
      throw new Error(
        `${UNSUPPORTED_MESSAGE}；请在独立交互式终端运行固定启动器：${launcherPath}`,
      );
    }

    let child;
    try {
      child = spawnImpl(
        "/usr/bin/open",
        ["-a", "Terminal", launcherPath],
        { detached: true, stdio: "ignore" },
      );
    } catch {
      throw new Error(OPEN_FAILED_MESSAGE);
    }

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        child.removeListener("spawn", onSpawn);
        child.removeListener("close", onClose);
        child.removeListener("error", onError);
      };
      const onSpawn = () => {
        child.unref();
      };
      const onClose = (code) => {
        cleanup();
        if (code === 0) resolve();
        else reject(new Error(OPEN_FAILED_MESSAGE));
      };
      const onError = () => {
        cleanup();
        reject(new Error(OPEN_FAILED_MESSAGE));
      };
      child.once("spawn", onSpawn);
      child.once("close", onClose);
      child.once("error", onError);
    });
  }

  async function open() {
    if (opened) return;
    if (!openingPromise) {
      openingPromise = openOnce().then(
        () => {
          opened = true;
          openingPromise = null;
        },
        (error) => {
          openingPromise = null;
          throw error;
        },
      );
    }
    return openingPromise;
  }

  function markConfigured() {
    opened = false;
  }

  return { open, markConfigured };
}
