import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

export const PROCESS_IDENTITY_ENV = 'AGENT_TOWER_PROCESS_IDENTITY';
export const PTY_WRAPPER_IDENTITY_SEED_ENV = 'AGENT_TOWER_PTY_IDENTITY_SEED';

interface UnixProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  birthMarker: string;
}

export interface UnixProcessIdentity {
  pid: number;
  pgid: number;
  birthIdentity: string;
  ownershipToken: string;
}

export interface UnixProcessGroupIdentity {
  pgid: number;
  members: UnixProcessIdentity[];
}

export interface UnixProcessIdentityAdapter {
  captureProcess(pid: number, ownershipToken: string): Promise<UnixProcessIdentity | null>;
  captureDescendantGroups(root: UnixProcessIdentity): Promise<UnixProcessGroupIdentity[]>;
  isProcessAlive(identity: UnixProcessIdentity): Promise<boolean>;
  isProcessGroupAlive(identity: UnixProcessGroupIdentity): Promise<boolean>;
  signalProcess(identity: UnixProcessIdentity, signal: NodeJS.Signals): Promise<boolean>;
  signalProcessGroup(identity: UnixProcessGroupIdentity, signal: NodeJS.Signals): Promise<boolean>;
}

export function unixProcessIdentityMatches(
  expected: UnixProcessIdentity,
  current: UnixProcessIdentity | null,
): boolean {
  return current !== null
    && current.pid === expected.pid
    && current.pgid === expected.pgid
    && current.birthIdentity === expected.birthIdentity
    && current.ownershipToken === expected.ownershipToken;
}

export function createUnixProcessIdentityAdapter(
  platform: NodeJS.Platform = process.platform,
): UnixProcessIdentityAdapter {
  return new DefaultUnixProcessIdentityAdapter(platform);
}

class DefaultUnixProcessIdentityAdapter implements UnixProcessIdentityAdapter {
  constructor(private readonly platform: NodeJS.Platform) {}

  async captureProcess(pid: number, ownershipToken: string): Promise<UnixProcessIdentity | null> {
    const row = (await this.listProcesses()).find((candidate) => candidate.pid === pid);
    if (!row) return null;
    const currentToken = await this.readOwnershipToken(pid);
    if (currentToken !== ownershipToken) return null;
    return {
      pid: row.pid,
      pgid: row.pgid,
      birthIdentity: `${row.birthMarker}:${ownershipToken}`,
      ownershipToken,
    };
  }

  async captureDescendantGroups(root: UnixProcessIdentity): Promise<UnixProcessGroupIdentity[]> {
    if (!await this.isProcessAlive(root)) return [];
    const rows = await this.listProcesses();
    const descendants = new Set<number>([root.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (descendants.has(row.pid) || !descendants.has(row.ppid)) continue;
        descendants.add(row.pid);
        changed = true;
      }
    }

    const candidates = rows.filter((row) => row.pid !== root.pid && descendants.has(row.pid));
    const identities = (await Promise.all(candidates.map((row) => (
      this.captureProcess(row.pid, root.ownershipToken)
    )))).filter((identity): identity is UnixProcessIdentity => identity !== null);
    const groups = new Map<number, UnixProcessIdentity[]>();
    for (const identity of identities) {
      const members = groups.get(identity.pgid) ?? [];
      members.push(identity);
      groups.set(identity.pgid, members);
    }
    return [...groups].map(([pgid, members]) => ({ pgid, members }));
  }

  async isProcessAlive(identity: UnixProcessIdentity): Promise<boolean> {
    return unixProcessIdentityMatches(
      identity,
      await this.captureProcess(identity.pid, identity.ownershipToken),
    );
  }

  async isProcessGroupAlive(identity: UnixProcessGroupIdentity): Promise<boolean> {
    for (const member of identity.members) {
      if (await this.isProcessAlive(member) && member.pgid === identity.pgid) return true;
    }
    return false;
  }

  async signalProcess(identity: UnixProcessIdentity, signal: NodeJS.Signals): Promise<boolean> {
    if (!await this.isProcessAlive(identity)) return false;
    try {
      process.kill(identity.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  async signalProcessGroup(identity: UnixProcessGroupIdentity, signal: NodeJS.Signals): Promise<boolean> {
    if (!await this.isProcessGroupAlive(identity)) return false;
    try {
      process.kill(-identity.pgid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async listProcesses(): Promise<UnixProcessRow[]> {
    if (this.platform === 'linux') return this.listLinuxProcesses();
    return this.listPsProcesses();
  }

  private async listLinuxProcesses(): Promise<UnixProcessRow[]> {
    const entries = await readdir('/proc', { withFileTypes: true }).catch(() => []);
    const rows = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry): Promise<UnixProcessRow | null> => {
        const pid = Number(entry.name);
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
        if (!stat) return null;
        const closeParen = stat.lastIndexOf(')');
        if (closeParen < 0) return null;
        const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
        const ppid = Number(fields[1]);
        const pgid = Number(fields[2]);
        const startTicks = fields[19];
        return Number.isFinite(ppid) && pgid > 0 && startTicks
          ? { pid, ppid, pgid, birthMarker: `linux:${startTicks}` }
          : null;
      }));
    return rows.filter((row): row is UnixProcessRow => row !== null);
  }

  private async listPsProcesses(): Promise<UnixProcessRow[]> {
    const output = await execFileText('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=']);
    return output.split('\n').map((line): UnixProcessRow | null => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) return null;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const pgid = Number(match[3]);
      const startedAt = match[4];
      return pid > 0 && Number.isFinite(ppid) && pgid > 0 && startedAt
        ? { pid, ppid, pgid, birthMarker: `${this.platform}:${startedAt}` }
        : null;
    }).filter((row): row is UnixProcessRow => row !== null);
  }

  private async readOwnershipToken(pid: number): Promise<string | null> {
    if (this.platform === 'linux') {
      const environ = await readFile(`/proc/${pid}/environ`).catch(() => null);
      if (!environ) return null;
      return extractOwnershipToken(environ.toString('utf8').replaceAll('\0', ' '));
    }
    const commandWithEnvironment = await execFileText('ps', [
      'eww',
      '-p',
      String(pid),
      '-o',
      'command=',
    ]);
    return extractOwnershipToken(commandWithEnvironment);
  }
}

function extractOwnershipToken(value: string): string | null {
  for (const key of [PROCESS_IDENTITY_ENV, PTY_WRAPPER_IDENTITY_SEED_ENV]) {
    const match = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(value);
    if (match?.[1]) return match[1];
  }
  return null;
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}
