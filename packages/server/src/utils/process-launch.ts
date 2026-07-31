import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CommandInvocation {
  command: string;
  args: string[];
}

export function getNodeRuntimeCommand(): string {
  return process.env.AGENT_TOWER_NODE_RUNTIME || process.execPath;
}

export const PTY_WRAPPER_ENV_KEYS = [
  'AGENT_TOWER_NODE_RUNTIME',
  'ELECTRON_RUN_AS_NODE',
] as const;

export function buildPtyWrapperEnv(
  agentEnv: Record<string, string>,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const wrapperEnv = { ...agentEnv };
  for (const key of PTY_WRAPPER_ENV_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined) {
      wrapperEnv[key] = value;
    }
  }
  return wrapperEnv;
}

const PTY_WRAPPER_SCRIPT = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createReadStream, unlinkSync } = require('node:fs');

const [mode, programPath, ...rest] = process.argv.slice(1);
const isWin = process.platform === 'win32';
const isCmdBat = isWin && /\.(cmd|bat)$/i.test(programPath);
const internalEnvKeys = ${JSON.stringify(PTY_WRAPPER_ENV_KEYS)};
const processIdentityEnvKey = 'AGENT_TOWER_PROCESS_IDENTITY';
const processIdentitySeedEnvKey = 'AGENT_TOWER_PTY_IDENTITY_SEED';
const processIdentityToken = process.env[processIdentitySeedEnvKey]
  || randomBytes(24).toString('base64url');

let child;
let cleanupTarget = null;
const sentSignals = new Set();
let forceKillTimer = null;
let treeExitPoll = null;
let finishing = false;
let groupIdentityTimers = [];
const trackedGroupMembers = new Map();

function getChildEnv() {
  const env = { ...process.env };
  for (const key of internalEnvKeys) {
    delete env[key];
  }
  delete env[processIdentitySeedEnvKey];
  env[processIdentityEnvKey] = processIdentityToken;
  return env;
}

function cleanup() {
  for (const timer of groupIdentityTimers) clearTimeout(timer);
  groupIdentityTimers = [];
  if (!cleanupTarget) return;
  const target = cleanupTarget;
  cleanupTarget = null;
  try { unlinkSync(target); } catch {}
}

function readProcessTable() {
  if (!child || isWin) return [];
  const base = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (base.status !== 0 || typeof base.stdout !== 'string') return [];
  const groupPids = base.stdout.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    return match && Number(match[3]) === child.pid ? Number(match[1]) : null;
  }).filter(Boolean);
  if (groupPids.length === 0) return [];
  const result = spawnSync('ps', [
    'eww',
    '-p',
    groupPids.join(','),
    '-o',
    'pid=,ppid=,pgid=,lstart=,command=',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  return result.stdout.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
    const token = match
      ? new RegExp('(?:^|\\s)' + processIdentityEnvKey + '=([^\\s]+)').exec(match[5])?.[1]
      : null;
    return match ? {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      birthIdentity: match[4] + ':' + token,
      ownershipToken: token,
    } : null;
  }).filter((row) => row && row.ownershipToken === processIdentityToken);
}

function captureProcessGroupIdentity() {
  if (!child || isWin) return;
  const rows = readProcessTable();
  const leader = rows.find((row) => row.pid === child.pid && row.pgid === child.pid);
  const trackedLeader = trackedGroupMembers.get(child.pid);
  if (!leader || (trackedLeader && trackedLeader !== leader.birthIdentity)) return;
  for (const row of rows) {
    if (row.pgid === child.pid) trackedGroupMembers.set(row.pid, row.birthIdentity);
  }
}

function scheduleProcessGroupIdentityCapture() {
  if (!child || isWin) return;
  // Capture synchronously while the group leader is still our known child.
  // Fast commands may spawn a background process and exit before a zero-delay
  // timer runs, leaving no trustworthy identity from which to sweep the group.
  captureProcessGroupIdentity();
  for (const delay of [50, 250, 1000, 5000]) {
    const timer = setTimeout(captureProcessGroupIdentity, delay);
    if (timer.unref) timer.unref();
    groupIdentityTimers.push(timer);
  }
}

function captureRemainingProcessGroupIdentity() {
  if (!child || isWin) return;
  const rows = readProcessTable();
  const groupRows = rows.filter((row) => row.pgid === child.pid);
  // A known PID with a different birth marker proves that the numeric group
  // identity was reused. Never replace captured identities in that case.
  if (groupRows.some((row) => {
    const startedAt = trackedGroupMembers.get(row.pid);
    return startedAt !== undefined && startedAt !== row.birthIdentity;
  })) return;
  for (const row of groupRows) {
    if (!trackedGroupMembers.has(row.pid)) trackedGroupMembers.set(row.pid, row.birthIdentity);
  }
}

function matchingTrackedGroupMembers() {
  if (!child || isWin || trackedGroupMembers.size === 0) return [];
  return readProcessTable().filter((row) => (
    row.pgid === child.pid && trackedGroupMembers.get(row.pid) === row.birthIdentity
  ));
}

const unixIdentityAdapter = {
  captureGroup: captureProcessGroupIdentity,
  captureRemainingGroup: captureRemainingProcessGroupIdentity,
  matchingGroupMembers: matchingTrackedGroupMembers,
  signalGroup(signal) {
    if (!child || matchingTrackedGroupMembers().length === 0) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return false;
    }
  },
  isGroupAlive() {
    return matchingTrackedGroupMembers().length > 0;
  },
};

// 终止 child 及其整个进程组。
// Unix 下 child 以 detached 启动（pgid === child.pid），组播信号可覆盖
// child 派生的整棵子树（pnpm dev、tsc --watch 等），防止孙进程被 init
// 收养成为孤儿。同一信号只发送一次；每次组播前重新校验组成员的
// birth identity 与本次 launch token，身份不匹配时拒绝发送。
// Windows 没有进程组信号语义，维持单进程击杀。
function killTree(signal) {
  if (!child || sentSignals.has(signal)) return;
  sentSignals.add(signal);
  if (isWin) {
    if (!child.killed) {
      try { child.kill(signal); } catch {}
    }
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    unixIdentityAdapter.captureGroup();
  }
  unixIdentityAdapter.signalGroup(signal);
}

// 收到终止信号后兜底：5 秒内进程组未退干净则升级为 SIGKILL。
function scheduleForceKill() {
  if (forceKillTimer) return;
  forceKillTimer = setTimeout(() => {
    killTree('SIGKILL');
  }, 5000);
  if (forceKillTimer.unref) forceKillTimer.unref();
}

function childProcessGroupExists() {
  if (!child || isWin) return false;
  return unixIdentityAdapter.isGroupAlive();
}

function exitWithChildResult(code, signal) {
  if (finishing) return;
  finishing = true;
  // The group leader may already be reaped. Capture the remaining members with
  // birth identities once, then every poll/signal revalidates those identities
  // so a later PGID/PID reuse cannot be mistaken for this process tree.
  unixIdentityAdapter.captureRemainingGroup();
  cleanup();
  // child 已退出：清扫其进程组内残留的后台孙进程（dev server、watch 等）。
  // SIGHUP 与 PTY 关闭语义一致。Unix wrapper 必须等到整个组消失后才能退出，
  // 否则 PTY owner 会把 wrapper exit 误判为进程树已清空。
  killTree('SIGHUP');
  const exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
  if (isWin || !childProcessGroupExists()) process.exit(exitCode);

  scheduleForceKill();
  treeExitPoll = setInterval(() => {
    if (childProcessGroupExists()) return;
    clearInterval(treeExitPoll);
    treeExitPoll = null;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    forceKillTimer = null;
    process.exit(exitCode);
  }, 50);
}

function exitWithError(error) {
  cleanup();
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

function escapeArgForCmd(arg) {
  if (/[\s"&|<>^()!]/.test(arg) || arg === '') {
    return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return arg;
}

function spawnCmd(args, stdioOpt) {
  const cmdLine = [programPath, ...args].map(escapeArgForCmd).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + cmdLine + '"'], {
    stdio: stdioOpt,
    env: getChildEnv(),
    windowsVerbatimArguments: true,
    windowsHide: true,
  });
}

// Unix: detached 使 child 自成进程组组长，便于整组击杀。
// stdio 继承的 PTY fd 不受影响（isatty 仍为 true）；终止信号统一由
// 本 wrapper 经 killTree 显式转发。Windows 下 detached 会脱离 ConPTY，
// 保持默认行为。
function spawnChild(args, stdioOpt) {
  return spawn(programPath, args, {
    stdio: stdioOpt,
    detached: !isWin,
    env: getChildEnv(),
    windowsHide: true,
  });
}

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => {
  process.on(signal, () => {
    killTree(signal);
    scheduleForceKill();
  });
});

if (mode === 'pipe-file') {
  const [stdinFile, ...args] = rest;
  cleanupTarget = stdinFile;
  let stdinStream = null;
  let stdinStreamClosed = false;
  let finishingWithChildResult = false;

  function isBrokenPipeError(error) {
    const code = error && error.code;
    return code === 'EPIPE'
      || code === 'ECONNRESET'
      || code === 'ERR_STREAM_DESTROYED'
      || code === 'ERR_STREAM_WRITE_AFTER_END';
  }

  function closeInputPipe() {
    if (stdinStream && !stdinStream.destroyed) {
      stdinStream.destroy();
    }
    if (child && child.stdin && !child.stdin.destroyed) {
      child.stdin.destroy();
    }
  }

  function afterInputClosed(callback) {
    if (!stdinStream || stdinStreamClosed) {
      cleanup();
      callback();
      return;
    }

    stdinStream.once('close', () => {
      cleanup();
      callback();
    });
    closeInputPipe();
  }

  function finishWithChildResult(code, signal) {
    if (finishingWithChildResult) return;
    finishingWithChildResult = true;
    afterInputClosed(() => exitWithChildResult(code, signal));
  }

  function exitWithPipeError(error) {
    killTree('SIGTERM');
    afterInputClosed(() => exitWithError(error));
  }

  child = isCmdBat
    ? spawnCmd(args, ['pipe', 'inherit', 'inherit'])
    : spawnChild(args, ['pipe', 'inherit', 'inherit']);
  scheduleProcessGroupIdentityCapture();

  child.on('error', (error) => {
    afterInputClosed(() => exitWithError(error));
  });
  child.on('exit', finishWithChildResult);

  stdinStream = createReadStream(stdinFile);
  stdinStream.on('close', () => {
    stdinStreamClosed = true;
    cleanup();
  });
  stdinStream.on('error', exitWithPipeError);

  if (child.stdin) {
    child.stdin.on('error', (error) => {
      if (isBrokenPipeError(error)) {
        afterInputClosed(() => {});
        return;
      }
      exitWithPipeError(error);
    });
    child.stdin.on('close', () => {
      if (stdinStream && !stdinStream.readableEnded && !stdinStream.destroyed) {
        stdinStream.destroy();
      }
    });
    stdinStream.pipe(child.stdin);
  } else {
    exitWithPipeError(new Error('Child stdin is not available'));
  }
} else {
  child = isCmdBat
    ? spawnCmd(rest, 'inherit')
    : spawnChild(rest, 'inherit');
  scheduleProcessGroupIdentityCapture();

  child.on('error', exitWithError);
  child.on('exit', exitWithChildResult);
}

`;

export function getBundledPrismaCommand(moduleDir: string): CommandInvocation {
  return {
    command: getNodeRuntimeCommand(),
    args: [path.resolve(moduleDir, '../node_modules/prisma/build/index.js')],
  };
}

export function buildPtyCommand(programPath: string, args: string[]): CommandInvocation {
  return {
    command: getNodeRuntimeCommand(),
    args: ['-e', PTY_WRAPPER_SCRIPT, 'spawn', programPath, ...args],
  };
}

export function buildPtyCommandWithStdin(
  programPath: string,
  args: string[],
  stdinFile: string
): CommandInvocation {
  return {
    command: getNodeRuntimeCommand(),
    args: ['-e', PTY_WRAPPER_SCRIPT, 'pipe-file', programPath, stdinFile, ...args],
  };
}

export function escapeArgForWindowsCmd(arg: string): string {
  if (/[\s"&|<>^()!]/.test(arg) || arg === '') {
    return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return arg;
}

export function buildWindowsCmdShimCommandLine(programPath: string, args: string[]): string {
  return [programPath, ...args].map(escapeArgForWindowsCmd).join(' ');
}

function appendPath(paths: string[], value: string | undefined): void {
  if (!value) return;
  const normalized = value.trim();
  if (!normalized || paths.some((item) => item.toLowerCase() === normalized.toLowerCase())) return;
  paths.push(normalized);
}

function getWindowsPathValue(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

export function buildWindowsPathWithUserBinFallbacks(env: NodeJS.ProcessEnv): string | undefined {
  const paths = (getWindowsPathValue(env) ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);

  const userProfile = env.USERPROFILE;
  const localAppData = env.LOCALAPPDATA;
  const appData = env.APPDATA;

  appendPath(paths, userProfile ? `${userProfile}\\.local\\bin` : undefined);
  appendPath(paths, localAppData ? `${localAppData}\\Programs\\OpenAI\\Codex\\bin` : undefined);
  appendPath(paths, localAppData ? `${localAppData}\\Programs\\codex\\bin` : undefined);
  appendPath(paths, localAppData ? `${localAppData}\\Programs\\Claude\\bin` : undefined);
  appendPath(paths, localAppData ? `${localAppData}\\Programs\\Cursor\\bin` : undefined);
  appendPath(paths, localAppData ? `${localAppData}\\cursor-agent` : undefined);
  appendPath(paths, appData ? `${appData}\\npm` : undefined);

  return paths.length > 0 ? paths.join(';') : undefined;
}

export function withWindowsUserPathFallbacks(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  const nextPath = buildWindowsPathWithUserBinFallbacks(env);
  if (nextPath) {
    next.PATH = nextPath;
    next.Path = nextPath;
  }
  return next;
}

function getUnixPathValue(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

function getUnixHomeDirectory(env: NodeJS.ProcessEnv): string | undefined {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function appendNodeManagerPathFallbacks(paths: string[], home: string): void {
  // npm-installed CLIs under nvm/fnm are commonly invisible to GUI-launched
  // macOS applications because those managers are initialized by shell startup
  // files rather than the login environment inherited by Electron.
  const versionRoots = [
    { root: path.join(home, '.nvm', 'versions', 'node'), suffix: ['bin'] },
    { root: path.join(home, '.fnm', 'node-versions'), suffix: ['installation', 'bin'] },
    { root: path.join(home, '.local', 'share', 'fnm', 'node-versions'), suffix: ['installation', 'bin'] },
  ];

  for (const { root, suffix } of versionRoots) {
    let entries: string[];
    try {
      entries = readdirSync(root).sort().reverse();
    } catch {
      continue;
    }

    for (const entry of entries) {
      appendPath(paths, path.join(root, entry, ...suffix));
    }
  }
}

export function buildUnixPathWithUserBinFallbacks(
  env: NodeJS.ProcessEnv,
  platform: 'darwin' | 'linux' = process.platform === 'darwin' ? 'darwin' : 'linux',
): string | undefined {
  const paths = (getUnixPathValue(env) ?? '')
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean);
  const home = getUnixHomeDirectory(env);

  if (home) {
    appendPath(paths, path.join(home, '.local', 'bin'));
    appendPath(paths, path.join(home, '.volta', 'bin'));
    appendPath(paths, path.join(home, '.bun', 'bin'));
    appendPath(paths, path.join(home, '.cargo', 'bin'));
    appendPath(paths, path.join(home, '.asdf', 'shims'));
    appendPath(paths, path.join(home, '.npm-global', 'bin'));
    appendPath(paths, path.join(home, '.npm-packages', 'bin'));
    appendPath(paths, path.join(home, 'bin'));
    if (platform === 'darwin') {
      appendPath(paths, path.join(home, 'Library', 'pnpm'));
    } else {
      appendPath(paths, path.join(home, '.local', 'share', 'pnpm'));
    }
    appendNodeManagerPathFallbacks(paths, home);
  }

  if (platform === 'darwin') {
    appendPath(paths, '/opt/homebrew/bin');
    appendPath(paths, '/opt/homebrew/sbin');
    appendPath(paths, '/usr/local/bin');
    appendPath(paths, '/usr/local/sbin');
  } else {
    appendPath(paths, '/usr/local/bin');
  }

  return paths.length > 0 ? paths.join(':') : undefined;
}

export function withUnixUserPathFallbacks(
  env: NodeJS.ProcessEnv = process.env,
  platform: 'darwin' | 'linux' = process.platform === 'darwin' ? 'darwin' : 'linux',
): NodeJS.ProcessEnv {
  const next = { ...env };
  const nextPath = buildUnixPathWithUserBinFallbacks(env, platform);
  if (nextPath) {
    next.PATH = nextPath;
  }
  return next;
}

export function getDefaultTerminalShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): CommandInvocation {
  if (platform === 'win32') {
    return {
      command: env.ComSpec || env.COMSPEC || 'cmd.exe',
      args: [],
    };
  }

  return {
    command: env.SHELL || '/bin/zsh',
    args: [],
  };
}

export function getPtyLogFilePath(tmpDir: string = os.tmpdir()): string {
  return path.join(tmpDir, 'agent-tower-pty.log');
}

export function normalizeCommandLookupOutput(
  stdout: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  // On Windows, `where` may return multiple hits (e.g. `claude`, `claude.cmd`,
  // `claude.ps1`). The extensionless POSIX shim is not directly executable by
  // Node's child_process.spawn, so prefer .cmd/.bat/.exe. The PTY wrapper and
  // Agent CLI command runner execute .cmd/.bat through controlled cmd.exe argv.
  if (platform === 'win32' && lines.length > 1) {
    const preferred = lines.find((l) => /\.(cmd|bat|exe)$/i.test(l));
    if (preferred) return preferred;
  }

  return lines[0];
}
