import { describe, expect, it, vi } from 'vitest';
import { ensureCloudflaredBinary } from '../cloudflared-runtime.js';

describe('ensureCloudflaredBinary', () => {
  it('uses an existing target-platform binary without reinstalling', async () => {
    const install = vi.fn(async () => '/mock/cloudflared');

    await ensureCloudflaredBinary({
      binaryPath: '/mock/cloudflared',
      exists: () => true,
      install,
    });

    expect(install).not.toHaveBeenCalled();
  });

  it('installs a missing binary once for concurrent callers', async () => {
    let installed = false;
    let finishInstall: (() => void) | undefined;
    const install = vi.fn(async (path: string) => {
      await new Promise<void>((resolve) => {
        finishInstall = resolve;
      });
      installed = true;
      return path;
    });
    const dependencies = {
      binaryPath: '/mock/cloudflared',
      exists: () => installed,
      install,
    };

    const first = ensureCloudflaredBinary(dependencies);
    const second = ensureCloudflaredBinary(dependencies);
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    finishInstall?.();
    await Promise.all([first, second]);

    expect(install).toHaveBeenCalledWith('/mock/cloudflared');
  });

  it('rejects a silent installer failure', async () => {
    await expect(ensureCloudflaredBinary({
      binaryPath: '/mock/cloudflared',
      exists: () => false,
      install: vi.fn(async (path: string) => path),
    })).rejects.toThrow('installer completed without creating');
  });
});
