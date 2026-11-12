import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export async function atomicReplaceFile(targetPath, content, operations = {}) {
  const {
    openFile = open,
    renameFile = rename,
    removeFile = rm,
    platform = process.platform,
  } = operations;
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  );
  let committed = false;

  try {
    const handle = await openFile(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      // Windows 使用 ACL，chmod 无法表达 Unix 的 0600 权限。
      if (platform !== "win32") {
        await handle.chmod(0o600);
        const fileMode = (await handle.stat()).mode & 0o777;
        if (fileMode !== 0o600) {
          throw new Error("临时配置文件权限校验失败");
        }
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    await renameFile(temporaryPath, targetPath);
    committed = true;
  } finally {
    if (!committed) {
      try {
        await removeFile(temporaryPath, { force: true });
      } catch {
        // Preserve the pre-commit failure; cleanup never changes commit status.
      }
    }
  }
}
