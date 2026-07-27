import { bin as defaultBinaryPath, install as defaultInstaller } from 'cloudflared';
import { existsSync } from 'node:fs';

interface CloudflaredRuntimeDependencies {
  binaryPath: string;
  exists: (path: string) => boolean;
  install: (path: string) => Promise<string>;
}

const defaultDependencies: CloudflaredRuntimeDependencies = {
  binaryPath: defaultBinaryPath,
  exists: existsSync,
  install: defaultInstaller,
};

let installPromise: Promise<void> | null = null;

export async function ensureCloudflaredBinary(
  dependencies: CloudflaredRuntimeDependencies = defaultDependencies,
): Promise<void> {
  if (dependencies.exists(dependencies.binaryPath)) return;

  if (!installPromise) {
    installPromise = (async () => {
      await dependencies.install(dependencies.binaryPath);
      if (!dependencies.exists(dependencies.binaryPath)) {
        throw new Error(`cloudflared installer completed without creating ${dependencies.binaryPath}`);
      }
    })();
  }

  const currentInstall = installPromise;
  try {
    await currentInstall;
  } finally {
    if (installPromise === currentInstall) {
      installPromise = null;
    }
  }
}
