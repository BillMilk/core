import { describe, expect, it, vi } from 'vitest';
import { WorkspaceBackgroundProcessManager } from '../workspace-background-process-manager.js';
import {
  unixProcessIdentityMatches,
  type UnixProcessGroupIdentity,
  type UnixProcessIdentity,
  type UnixProcessIdentityAdapter,
} from '../../utils/unix-process-identity.js';

class FakePty {
  pid = 4242;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  write = vi.fn();
  resize = vi.fn();

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  kill = vi.fn(() => this.emitExit(0));

  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number) {
    for (const listener of [...this.exitListeners]) listener({ exitCode });
  }
}

function createFakeUnixAdapter(
  shell: FakePty,
  options: {
    groups?: (root: UnixProcessIdentity) => UnixProcessGroupIdentity[];
    groupAlive?: (group: UnixProcessGroupIdentity) => boolean;
  } = {},
) {
  const captureProcess = vi.fn(async (pid: number, ownershipToken: string) => ({
    pid,
    pgid: pid,
    birthIdentity: `test:${pid}:${ownershipToken}`,
    ownershipToken,
  }));
  const adapter: UnixProcessIdentityAdapter = {
    captureProcess,
    captureDescendantGroups: vi.fn(async (root) => options.groups?.(root) ?? []),
    isProcessAlive: vi.fn(async () => true),
    isProcessGroupAlive: vi.fn(async (group) => options.groupAlive?.(group) ?? false),
    signalProcess: vi.fn(async (_identity, _signal) => {
      shell.emitExit(0);
      return true;
    }),
    signalProcessGroup: vi.fn(async () => true),
  };
  return adapter;
}

describe('WorkspaceBackgroundProcessManager', () => {
  it('keeps bounded sequence logs and reports stale cursors', async () => {
    const shell = new FakePty();
    const unixProcessAdapter = createFakeUnixAdapter(shell);
    const manager = new WorkspaceBackgroundProcessManager({
      spawn: vi.fn(() => shell) as any,
      resolveCommand: async () => process.execPath,
      platform: 'linux',
      unixProcessAdapter,
    });
    await manager.start('service-1', 'runtime-1', {
      command: 'node',
      args: [],
      cwd: process.cwd(),
    }, vi.fn());

    for (let index = 0; index < 2_005; index++) shell.emitData(`line-${index}\n`);

    const logs = manager.getLogs('service-1', { afterSeq: 1, limit: 200, maxChars: 64 * 1024 });
    expect(logs.entries).toHaveLength(200);
    expect(logs.oldestSeq).toBeGreaterThan(1);
    expect(logs.runtimeInstanceId).toBe('runtime-1');
    expect(logs.reset).toBe(false);
    expect(logs.truncated).toBe(true);
    expect(logs.hasMore).toBe(true);
    expect(logs.nextSeq).toBe(logs.entries.at(-1)!.seq + 1);
    expect(manager.getLogs('service-1', { limit: 200, maxChars: 64 * 1024 }).truncated)
      .toBe(true);

    const generationResetLogs = manager.getLogs('service-1', {
      afterSeq: 2_005,
      runtimeInstanceId: 'runtime-old',
      limit: 200,
      maxChars: 64 * 1024,
    });
    expect(generationResetLogs).toMatchObject({
      runtimeInstanceId: 'runtime-1',
      oldestSeq: logs.oldestSeq,
      reset: true,
      truncated: true,
      hasMore: true,
    });
    expect(generationResetLogs.entries[0].seq).toBe(logs.oldestSeq);

    const resetLogs = manager.getLogs('service-after-app-restart', {
      afterSeq: logs.nextSeq - 1,
      limit: 200,
      maxChars: 64 * 1024,
    });
    expect(resetLogs).toEqual({
      runtimeInstanceId: null,
      entries: [],
      oldestSeq: 1,
      nextSeq: 1,
      reset: true,
      truncated: false,
      hasMore: false,
    });
  });

  it('keeps normal backlog pagination separate from lost logs', async () => {
    const shell = new FakePty();
    const manager = new WorkspaceBackgroundProcessManager({
      spawn: vi.fn(() => shell) as any,
      resolveCommand: async () => process.execPath,
      platform: 'linux',
      unixProcessAdapter: createFakeUnixAdapter(shell),
    });
    await manager.start('service-1', 'runtime-1', {
      command: 'node',
      args: [],
      cwd: process.cwd(),
    }, vi.fn());
    for (let index = 0; index < 450; index++) shell.emitData(`line-${index}\n`);

    const first = manager.getLogs('service-1', {
      afterSeq: 0,
      runtimeInstanceId: 'runtime-1',
      limit: 200,
      maxChars: 64 * 1024,
    });
    const second = manager.getLogs('service-1', {
      afterSeq: first.nextSeq - 1,
      runtimeInstanceId: first.runtimeInstanceId!,
      limit: 200,
      maxChars: 64 * 1024,
    });
    const final = manager.getLogs('service-1', {
      afterSeq: second.nextSeq - 1,
      runtimeInstanceId: second.runtimeInstanceId!,
      limit: 200,
      maxChars: 64 * 1024,
    });

    expect(first).toMatchObject({ reset: false, truncated: false, hasMore: true, nextSeq: 201 });
    expect(second).toMatchObject({ reset: false, truncated: false, hasMore: true, nextSeq: 401 });
    expect(final).toMatchObject({ reset: false, truncated: false, hasMore: false, nextSeq: 451 });
    expect([...first.entries, ...second.entries, ...final.entries]).toHaveLength(450);
  });

  it('binds logs to the active runtime generation regardless of cursor values', async () => {
    const firstShell = new FakePty();
    const secondShell = new FakePty();
    const manager = new WorkspaceBackgroundProcessManager({
      spawn: vi.fn()
        .mockReturnValueOnce(firstShell)
        .mockReturnValueOnce(secondShell) as any,
      resolveCommand: async () => process.execPath,
      platform: 'linux',
      unixProcessAdapter: createFakeUnixAdapter(firstShell),
    });
    await manager.start('service-1', 'runtime-old', {
      command: 'node',
      args: [],
      cwd: process.cwd(),
    }, vi.fn());
    firstShell.emitData('old\n');
    firstShell.emitExit(0);
    await Promise.resolve();

    await manager.start('service-1', 'runtime-new', {
      command: 'node',
      args: [],
      cwd: process.cwd(),
    }, vi.fn());
    secondShell.emitData('new-1\n');
    secondShell.emitData('new-2\n');
    secondShell.emitData('new-3\n');

    const logs = manager.getLogs('service-1', {
      afterSeq: 1,
      runtimeInstanceId: 'runtime-old',
      limit: 200,
      maxChars: 64 * 1024,
    });

    expect(logs).toMatchObject({
      runtimeInstanceId: 'runtime-new',
      nextSeq: 4,
      reset: true,
      truncated: false,
      hasMore: false,
    });
    expect(logs.entries.map(entry => entry.data)).toEqual(['new-1\n', 'new-2\n', 'new-3\n']);
  });

  it('paginates every retained entry from a new runtime generation', async () => {
    const shell = new FakePty();
    const manager = new WorkspaceBackgroundProcessManager({
      spawn: vi.fn(() => shell) as any,
      resolveCommand: async () => process.execPath,
      platform: 'linux',
      unixProcessAdapter: createFakeUnixAdapter(shell),
    });
    await manager.start('service-1', 'runtime-new', {
      command: 'node',
      args: [],
      cwd: process.cwd(),
    }, vi.fn());
    for (let index = 0; index < 450; index++) shell.emitData(`line-${index}\n`);

    const pages = [];
    let page = manager.getLogs('service-1', {
      afterSeq: 450,
      runtimeInstanceId: 'runtime-old',
      limit: 200,
      maxChars: 64 * 1024,
    });
    while (true) {
      pages.push(page);
      if (!page.hasMore) break;
      page = manager.getLogs('service-1', {
        afterSeq: page.nextSeq - 1,
        runtimeInstanceId: page.runtimeInstanceId!,
        limit: 200,
        maxChars: 64 * 1024,
      });
    }

    expect(pages.map(current => current.entries.length)).toEqual([200, 200, 50]);
    expect(pages[0]).toMatchObject({ reset: true, truncated: false, nextSeq: 201 });
    expect(pages.slice(1).every(current => !current.reset && !current.truncated)).toBe(true);
    expect(pages.flatMap(current => current.entries).map(entry => entry.seq))
      .toEqual(Array.from({ length: 450 }, (_, index) => index + 1));
  });

  it('continues generation reset pagination when maxChars limits each page', async () => {
    const shell = new FakePty();
    const manager = new WorkspaceBackgroundProcessManager({
      spawn: vi.fn(() => shell) as any,
      resolveCommand: async () => process.execPath,
      platform: 'linux',
      unixProcessAdapter: createFakeUnixAdapter(shell),
    });
    await manager.start('service-1', 'runtime-new', {
      command: 'node',
      args: [],
      cwd: process.cwd(),
    }, vi.fn());
    for (let index = 0; index < 7; index++) shell.emitData(`item-${index}\n`);

    const pages = [];
    let page = manager.getLogs('service-1', {
      afterSeq: 7,
      runtimeInstanceId: 'runtime-old',
      limit: 200,
      maxChars: 14,
    });
    while (true) {
      pages.push(page);
      if (!page.hasMore) break;
      page = manager.getLogs('service-1', {
        afterSeq: page.nextSeq - 1,
        runtimeInstanceId: page.runtimeInstanceId!,
        limit: 200,
        maxChars: 14,
      });
    }

    expect(pages.map(current => current.entries.length)).toEqual([2, 2, 2, 1]);
    expect(pages[0]).toMatchObject({ reset: true, truncated: false, hasMore: true });
    expect(pages.at(-1)).toMatchObject({ reset: false, truncated: false, hasMore: false, nextSeq: 8 });
    expect(pages.flatMap(current => current.entries).map(entry => entry.data))
      .toEqual(Array.from({ length: 7 }, (_, index) => `item-${index}\n`));
  });

  it('writes to the active generation and waits for PTY exit on stop', async () => {
    const shell = new FakePty();
    const onExit = vi.fn();
    const unixProcessAdapter = createFakeUnixAdapter(shell);
    const manager = new WorkspaceBackgroundProcessManager({
      spawn: vi.fn(() => shell) as any,
      resolveCommand: async () => process.execPath,
      platform: 'linux',
      unixProcessAdapter,
    });
    await manager.start('service-1', 'runtime-1', {
      command: 'node',
      args: [],
      cwd: process.cwd(),
    }, onExit);

    manager.write('service-1', 'runtime-1', 'yes\n');
    expect(shell.write).toHaveBeenCalledWith('yes\n');
    await expect(manager.stop('service-1', 'runtime-1')).resolves.toBe(0);
    await Promise.resolve();
    expect(onExit).toHaveBeenCalledWith({
      serviceId: 'service-1',
      runtimeInstanceId: 'runtime-1',
      exitCode: 0,
    });
    expect(unixProcessAdapter.signalProcess).toHaveBeenCalledWith(
      expect.objectContaining({ pid: shell.pid }),
      'SIGTERM',
    );
    expect(shell.kill).not.toHaveBeenCalled();
    expect(manager.has('service-1')).toBe(false);
  });

  it('releases retained logs only after a service is no longer running', async () => {
    const shell = new FakePty();
    const unixProcessAdapter = createFakeUnixAdapter(shell);
    const manager = new WorkspaceBackgroundProcessManager({
      spawn: vi.fn(() => shell) as any,
      resolveCommand: async () => process.execPath,
      platform: 'linux',
      unixProcessAdapter,
    });
    await manager.start('service-1', 'runtime-1', {
      command: 'node',
      args: [],
      cwd: process.cwd(),
    }, vi.fn());
    shell.emitData('retained log');

    expect(() => manager.forget('service-1')).toThrow('running workspace service');
    await manager.stop('service-1', 'runtime-1');
    manager.forget('service-1');

    expect(manager.getLogs('service-1', { limit: 10, maxChars: 1_000 }).entries).toEqual([]);
  });

  it('does not signal a descendant group after its captured member identity is gone', async () => {
    const shell = new FakePty();
    const unixProcessAdapter = createFakeUnixAdapter(shell, {
      groups: (root) => [{
        pgid: 5000,
        members: [{
          pid: 5000,
          pgid: 5000,
          birthIdentity: `same-second:${root.ownershipToken}`,
          ownershipToken: root.ownershipToken,
        }],
      }],
      groupAlive: () => false,
    });
    const manager = new WorkspaceBackgroundProcessManager({
      spawn: vi.fn(() => shell) as any,
      resolveCommand: async () => process.execPath,
      platform: 'linux',
      unixProcessAdapter,
    });
    await manager.start('service-1', 'runtime-1', {
      command: 'node',
      args: [],
      cwd: process.cwd(),
    }, vi.fn());

    await expect(manager.stop('service-1', 'runtime-1')).resolves.toBe(0);

    expect(unixProcessAdapter.signalProcessGroup).not.toHaveBeenCalled();
  });

  it('distinguishes same-second PID reuse with the per-launch ownership token', () => {
    const captured: UnixProcessIdentity = {
      pid: 4242,
      pgid: 4242,
      birthIdentity: 'darwin:Thu Jul 30 21:00:00 2026:launch-old',
      ownershipToken: 'launch-old',
    };
    const reused: UnixProcessIdentity = {
      pid: 4242,
      pgid: 4242,
      birthIdentity: 'darwin:Thu Jul 30 21:00:00 2026:launch-new',
      ownershipToken: 'launch-new',
    };

    expect(unixProcessIdentityMatches(captured, reused)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('owns a real PTY and force-kills a grandchild that ignores graceful signals', async () => {
    const manager = new WorkspaceBackgroundProcessManager({
      resolveCommand: async () => process.execPath,
    });
    const onExit = vi.fn();
    let childPid = 0;
    const script = [
      "const { spawn } = require('node:child_process')",
      "const childScript = ['SIGTERM', 'SIGHUP', 'SIGINT'].map(s => `process.on('${s}', () => {})`).join(';') + ';setInterval(() => {}, 1000)'",
      "const child = spawn(process.execPath, ['-e', childScript], { stdio: 'ignore' })",
      "console.log('CHILD_PID=' + child.pid)",
      'setInterval(() => {}, 1000)',
    ].join(';');

    try {
      await manager.start('real-service', 'real-runtime', {
        command: process.execPath,
        args: ['-e', script],
        cwd: process.cwd(),
      }, onExit);

      const deadline = Date.now() + 5_000;
      while (!childPid && Date.now() < deadline) {
        const output = manager.getLogs('real-service', {
          limit: 100,
          maxChars: 64 * 1024,
        }).entries.map((entry) => entry.data).join('');
        childPid = Number(/CHILD_PID=(\d+)/.exec(output)?.[1] ?? 0);
        if (!childPid) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(childPid).toBeGreaterThan(0);
      expect(manager.has('real-service', 'real-runtime')).toBe(true);

      await manager.stop('real-service', 'real-runtime');
      const processDeadline = Date.now() + 2_000;
      let childAlive = true;
      while (childAlive && Date.now() < processDeadline) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch {
          childAlive = false;
        }
      }
      expect(childAlive).toBe(false);
      expect(onExit).toHaveBeenCalledOnce();
    } finally {
      await manager.stopAll().catch(() => undefined);
      if (childPid > 0) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The expected path already removed it.
        }
      }
    }
  }, 20_000);
});
