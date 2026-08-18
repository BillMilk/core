import { execFile } from 'node:child_process';
import path from 'node:path';

const WINDOWS_PATH_REGISTRY_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
] as const;

export type WindowsRegistryQuery = (
  key: string,
  env: NodeJS.ProcessEnv,
) => Promise<string>;

function getEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function appendUniquePath(entries: string[], value: string): void {
  const normalized = value.trim().replace(/^"|"$/g, '');
  if (!normalized) return;
  if (entries.some(entry => entry.toLowerCase() === normalized.toLowerCase())) return;
  entries.push(normalized);
}

function expandWindowsEnvironmentVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => (
    getEnvironmentValue(env, name) ?? match
  ));
}

export function parseWindowsRegistryPath(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)\s*$/i);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export function mergeWindowsPathValues(
  env: NodeJS.ProcessEnv,
  registryPathValues: readonly string[],
): string | undefined {
  const entries: string[] = [];
  const inheritedPath = getEnvironmentValue(env, 'PATH') ?? '';

  for (const value of [inheritedPath, ...registryPathValues]) {
    const expanded = expandWindowsEnvironmentVariables(value, env);
    for (const entry of expanded.split(';')) {
      appendUniquePath(entries, entry);
    }
  }

  return entries.length > 0 ? entries.join(';') : undefined;
}

function defaultRegistryQuery(key: string, env: NodeJS.ProcessEnv): Promise<string> {
  const systemRoot = getEnvironmentValue(env, 'SystemRoot') || 'C:\\Windows';
  const regExe = path.win32.join(systemRoot, 'System32', 'reg.exe');

  return new Promise((resolve, reject) => {
    execFile(regExe, ['query', key, '/v', 'Path'], {
      encoding: 'utf8',
      env,
      timeout: 3_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

/**
 * Rebuild PATH from the process environment plus the current Windows registry.
 * GUI apps may keep Explorer's stale environment for hours after a CLI is installed.
 */
export async function buildFreshWindowsPath(
  env: NodeJS.ProcessEnv = process.env,
  query: WindowsRegistryQuery = defaultRegistryQuery,
): Promise<string | undefined> {
  const registryPathValues: string[] = [];

  for (const key of WINDOWS_PATH_REGISTRY_KEYS) {
    try {
      const value = parseWindowsRegistryPath(await query(key, env));
      if (value) registryPathValues.push(value);
    } catch {
      // A missing or unreadable registry value must not prevent desktop startup.
    }
  }

  return mergeWindowsPathValues(env, registryPathValues);
}

export function setEnvironmentPath(env: NodeJS.ProcessEnv, value: string): void {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.PATH = value;
}
