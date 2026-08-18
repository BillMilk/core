import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const builderCli = path.join(packageRoot, 'node_modules/electron-builder/out/cli/cli.js');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === 'corepack',
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

if (process.platform !== 'win32') {
  throw new Error('package-win-dir.mjs must be run on Windows');
}
if (!existsSync(builderCli)) {
  throw new Error(`Missing electron-builder CLI: ${builderCli}`);
}

const shimDir = mkdtempSync(path.join(os.tmpdir(), 'agent-tower-corepack-'));
try {
  if (!run('corepack', ['enable', '--install-directory', shimDir])) {
    throw new Error('Failed to create temporary Corepack shims');
  }

  const pnpmShim = path.join(shimDir, 'pnpm.cmd');
  if (!existsSync(pnpmShim)) {
    throw new Error(`Corepack did not create pnpm.cmd in ${shimDir}`);
  }

  const env = {
    ...process.env,
    PATH: [shimDir, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  if (!run(process.execPath, [
    builderCli,
    '--dir',
    '--win',
    '--x64',
    '--publish',
    'never',
  ], { env, shell: false })) {
    throw new Error('electron-builder failed to create win-unpacked');
  }
} finally {
  rmSync(shimDir, { recursive: true, force: true });
}
