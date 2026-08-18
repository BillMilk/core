import { describe, expect, it, vi } from 'vitest';
import {
  buildFreshWindowsPath,
  mergeWindowsPathValues,
  parseWindowsRegistryPath,
  setEnvironmentPath,
} from '../src/windows-path.js';

describe('Windows desktop PATH refresh', () => {
  it('parses both regular and expandable registry PATH values', () => {
    expect(parseWindowsRegistryPath(
      '\r\n    Path    REG_SZ    D:\\tools\\Git\\cmd;C:\\Windows\\System32\r\n',
    )).toBe('D:\\tools\\Git\\cmd;C:\\Windows\\System32');
    expect(parseWindowsRegistryPath(
      '    Path    REG_EXPAND_SZ    %SystemRoot%\\System32\r\n',
    )).toBe('%SystemRoot%\\System32');
  });

  it('merges fresh machine and user PATH entries without duplicates', () => {
    const merged = mergeWindowsPathValues({
      Path: 'C:\\Windows\\System32;C:\\old-bin',
      SystemRoot: 'C:\\Windows',
    }, [
      '%SystemRoot%\\System32;D:\\tools\\Git\\cmd',
      'C:\\Users\\alice\\AppData\\Roaming\\npm',
    ]);

    expect(merged?.split(';')).toEqual([
      'C:\\Windows\\System32',
      'C:\\old-bin',
      'D:\\tools\\Git\\cmd',
      'C:\\Users\\alice\\AppData\\Roaming\\npm',
    ]);
  });

  it('reads both registry scopes even when one query fails', async () => {
    const query = vi.fn(async (key: string) => {
      if (key.startsWith('HKLM')) {
        return '    Path    REG_SZ    D:\\tools\\Git\\cmd\r\n';
      }
      throw new Error('missing user PATH');
    });

    const merged = await buildFreshWindowsPath({ PATH: 'C:\\Windows\\System32' }, query);

    expect(query).toHaveBeenCalledTimes(2);
    expect(merged?.split(';')).toContain('D:\\tools\\Git\\cmd');
  });

  it('normalizes duplicate PATH key casing before spawning the backend', () => {
    const env = {
      Path: 'stale',
      PATH: 'also-stale',
      OTHER: 'keep',
    };

    setEnvironmentPath(env, 'D:\\tools\\Git\\cmd');

    expect(env).toEqual({
      PATH: 'D:\\tools\\Git\\cmd',
      OTHER: 'keep',
    });
  });
});
