import { install as defaultInstaller, use as useCloudflaredBinary } from 'cloudflared';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../utils/data-dir.js';

interface CloudflaredRuntimeDependencies {
  binaryPath: string;
  exists: (path: string) => boolean;
  install: (path: string) => Promise<string>;
  activate: (path: string) => void;
}

export function getCloudflaredBinaryPath(dataDir = resolveDataDir()): string {
  if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;
  const fileName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  return path.join(dataDir, 'bin', fileName);
}

async function installCloudflaredBinary(binaryPath: string): Promise<string> {
  const parentDir = path.dirname(binaryPath);
  mkdirSync(parentDir, { recursive: true });
  const stagingDir = mkdtempSync(path.join(parentDir, '.cloudflared-'));
  const stagedBinary = path.join(stagingDir, path.basename(binaryPath));

  try {
    await defaultInstaller(stagedBinary);
    if (!existsSync(stagedBinary)) {
      throw new Error(`cloudflared installer completed without creating ${stagedBinary}`);
    }
    if (!existsSync(binaryPath)) renameSync(stagedBinary, binaryPath);
    return binaryPath;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function getDefaultDependencies(): CloudflaredRuntimeDependencies {
  return {
    binaryPath: getCloudflaredBinaryPath(),
    exists: existsSync,
    install: installCloudflaredBinary,
    activate: useCloudflaredBinary,
  };
}

const installPromises = new Map<string, Promise<void>>();

export async function ensureCloudflaredBinary(
  dependencies: CloudflaredRuntimeDependencies = getDefaultDependencies(),
): Promise<void> {
  if (dependencies.exists(dependencies.binaryPath)) {
    dependencies.activate(dependencies.binaryPath);
    return;
  }

  let installPromise = installPromises.get(dependencies.binaryPath);
  if (!installPromise) {
    installPromise = (async () => {
      await dependencies.install(dependencies.binaryPath);
      if (!dependencies.exists(dependencies.binaryPath)) {
        throw new Error(`cloudflared installer completed without creating ${dependencies.binaryPath}`);
      }
    })();
    installPromises.set(dependencies.binaryPath, installPromise);
  }

  try {
    await installPromise;
  } finally {
    if (installPromises.get(dependencies.binaryPath) === installPromise) {
      installPromises.delete(dependencies.binaryPath);
    }
  }

  if (!dependencies.exists(dependencies.binaryPath)) {
    throw new Error(`cloudflared binary is missing after installation: ${dependencies.binaryPath}`);
  }
  dependencies.activate(dependencies.binaryPath);
}
