import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export function resolveBundledClaudeExecutable(): string | undefined {
  let adapterPath: string;
  try {
    adapterPath = require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');
  } catch {
    return undefined;
  }

  const adapterRequire = createRequire(adapterPath);
  let sdkPath: string;
  try {
    sdkPath = adapterRequire.resolve('@anthropic-ai/claude-agent-sdk');
  } catch {
    return undefined;
  }

  const sdkRequire = createRequire(sdkPath);
  const extension = process.platform === 'win32' ? '.exe' : '';
  const packageNames = claudePlatformPackageNames();
  for (const packageName of packageNames) {
    try {
      const packageJson = sdkRequire.resolve(`@anthropic-ai/${packageName}/package.json`);
      return path.join(path.dirname(packageJson), `claude${extension}`);
    } catch {
      // Optional platform packages intentionally differ by host.
    }
  }
  return undefined;
}

export function claudePlatformPackageNames(): string[] {
  if (process.platform !== 'linux') {
    return [`claude-agent-sdk-${process.platform}-${process.arch}`];
  }
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const prefix = `claude-agent-sdk-linux-${process.arch}`;
  return report?.header?.glibcVersionRuntime
    ? [prefix, `${prefix}-musl`]
    : [`${prefix}-musl`, prefix];
}
