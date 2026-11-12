import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { atomicReplaceFile } from "./atomic-file.mjs";
import { getRegistrationState, updateAgentConfig } from "./agent-config.mjs";

async function readConfig(configPath) {
  try {
    const stat = await lstat(configPath);
    // 通过真实目标写入，保留用户 dotfiles 中的符号链接。
    const filePath = stat.isSymbolicLink() ? await realpath(configPath) : configPath;
    if (!(await lstat(filePath)).isFile()) throw new Error("配置路径不是普通文件");
    return { filePath, source: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") {
      // 悬空链接不能当作新配置覆盖。
      const dangling = await lstat(configPath).catch(() => null);
      if (!dangling) return { filePath: configPath, source: null };
    }
    throw new Error(`无法读取配置（${error.code || "文件类型异常"}）：${configPath}`);
  }
}

export async function getAgentStatus(target, projectDirectory) {
  const { source } = await readConfig(target.configPath);
  return { ...target, state: getRegistrationState(source, target, projectDirectory) };
}

export async function ensureProjectEnv(projectDirectory, platform = process.platform) {
  const envPath = path.join(projectDirectory, ".env");
  try {
    await copyFile(path.join(projectDirectory, ".env.example"), envPath, constants.COPYFILE_EXCL);
    if (platform !== "win32") await chmod(envPath, 0o600);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw new Error(`无法创建项目 .env（${error.code || "写入失败"}）`);
  }
}

export async function planAgentChange(target, { projectDirectory, action, nodePath = process.execPath }) {
  const { filePath, source } = await readConfig(target.configPath);
  const updated = updateAgentConfig(source, target, projectDirectory, action, nodePath);
  return { target, filePath, source, updated, changed: source !== updated, action, projectDirectory };
}

export async function applyAgentChange(plan, { platform = process.platform, writeConfig = atomicReplaceFile } = {}) {
  if (!plan.changed) return { ...plan, backupPath: null };
  await mkdir(path.dirname(plan.filePath), { recursive: true });
  const lockPath = `${plan.filePath}.zentao-mcp.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(error.code === "EEXIST"
      ? `另一个安装工具正在操作此配置；若上次异常退出，请确认后删除锁文件：${lockPath}`
      : `无法锁定配置（${error.code || "写入失败"}）：${plan.target.configPath}`);
  }
  try {
    const latest = await readConfig(plan.target.configPath);
    if (latest.filePath !== plan.filePath || latest.source !== plan.source) {
      throw new Error(`配置已被其他程序修改，请重新运行：${plan.target.configPath}`);
    }
    let backupPath = null;
    if (plan.source !== null) {
      backupPath = `${plan.filePath}.zentao-mcp-${randomUUID()}.bak`;
      await writeFile(backupPath, plan.source, { flag: "wx", mode: 0o600 });
    }
    // 备份后再检查一次，避免覆盖同时保存配置的编辑器。
    if ((await readConfig(plan.target.configPath)).source !== plan.source) {
      throw new Error(`配置已被其他程序修改，请重新运行：${plan.target.configPath}`);
    }
    await writeConfig(plan.filePath, plan.updated, { platform });
    return { ...plan, backupPath };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
