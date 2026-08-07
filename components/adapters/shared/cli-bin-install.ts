import { existsSync } from "node:fs";
import { chmod, link, mkdir, symlink, unlink } from "node:fs/promises";
import { join, resolve, delimiter } from "node:path";

function cliDistPathFromAdapterRoot(adapterRoot: string): string {
  const bundledPath = resolve(adapterRoot, "dist", "lightmem2.js");
  if (existsSync(bundledPath)) return bundledPath;
  return resolve(adapterRoot, "..", "..", "products", "cli", "dist", "cli.js");
}

async function createCliLink(targetPath: string, binPath: string): Promise<void> {
  try {
    await symlink(targetPath, binPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (process.platform !== "win32" || !["EACCES", "EPERM", "UNKNOWN"].includes(code ?? "")) {
      throw error;
    }
    await link(targetPath, binPath);
  }
}

export async function installLightmem2CliBin(params: {
  adapterRoot: string;
  homeDir?: string;
  binDir?: string;
}): Promise<{
  installed: boolean;
  binPath: string;
  binDir: string;
  cliDistPath: string;
  binDirOnPath: boolean;
}> {
  const homeDir = params.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const binDir = params.binDir ?? join(homeDir, ".local", "bin");
  const cliDistPath = cliDistPathFromAdapterRoot(params.adapterRoot);
  const binPath = join(binDir, "lightmem2");
  const binDirOnPath = String(process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => resolve(entry) === resolve(binDir));

  if (!existsSync(cliDistPath)) {
    return {
      installed: false,
      binPath,
      binDir,
      cliDistPath,
      binDirOnPath,
    };
  }

  await mkdir(binDir, { recursive: true });
  await chmod(cliDistPath, 0o755).catch(() => undefined);
  await unlink(binPath).catch(() => undefined);
  await createCliLink(cliDistPath, binPath);
  await chmod(binPath, 0o755).catch(() => undefined);

  return {
    installed: true,
    binPath,
    binDir,
    cliDistPath,
    binDirOnPath,
  };
}
