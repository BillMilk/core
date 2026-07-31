import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AgentType, SessionStatus, TaskStatus } from '../../types/index.js';
import { EventBus } from '../../core/event-bus.js';
import type { EarlyPtyEvent } from '../../executors/base.executor.js';
import { RuntimeType, type RuntimeCapabilities } from '@agent-tower/shared';
import type {
  DriverSession,
  RuntimeDriver,
  RuntimeOpenInput,
  RuntimeRunTurnInput,
  RuntimeTurnOutcome,
} from '../../runtime/contracts.js';
import { StaticRuntimeRegistry } from '../../runtime/runtime-registry.js';
import {
  AGENT_API_CREDENTIAL_ENV,
  clearAgentApiCredentials,
  validateAgentApiCredential,
} from '../../utils/agent-api-credential.js';

/**
 * Session 状态与真实进程状态一致性的集成测试（真实 SQLite + 真实 parser/MsgStore/Pipeline，
 * 仅 mock executor.spawn 返回的 PTY）。
 *
 * 覆盖用户报告的"卡住"关键面：
 * - PTY 退出后 session 必须离开 RUNNING（COMPLETED/FAILED），快照落库
 * - spawn→attach 窗口内就退出的进程（early exit 竞态）不得把 session 留在 RUNNING
 */

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-session-lifecycle-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const {
  spawnMock,
  getProviderByIdMock,
  getExecutorByProviderMock,
  createMockExecutor,
} = vi.hoisted(() => {
  const spawnMock = vi.fn();
  const createMockExecutor = () => ({
    agentType: 'CODEX',
    displayName: 'Mock Codex',
    getAvailabilityInfo: vi.fn(),
    getCapabilities: vi.fn(() => []),
    spawn: spawnMock,
    // No spawnFollowUp: sendMessage exercises the new-spawn path.
  });
  return {
    spawnMock,
    getProviderByIdMock: vi.fn(),
    getExecutorByProviderMock: vi.fn(),
    createMockExecutor,
  };
});

vi.mock('../../executors/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../executors/index.js')>();
  getExecutorByProviderMock.mockImplementation(createMockExecutor);
  return {
    ...actual,
    getExecutor: vi.fn(createMockExecutor),
    getExecutorByProvider: getExecutorByProviderMock,
    getProviderById: getProviderByIdMock,
  };
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let SessionManager: typeof import('../session-manager.js').SessionManager;
let sessionMsgStoreManager: typeof import('../../output/index.js').sessionMsgStoreManager;
let WorkspaceBackgroundService: typeof import('../workspace-background-service.service.js').WorkspaceBackgroundService;
let WorkspaceBackgroundProcessManager: typeof import('../workspace-background-process-manager.js').WorkspaceBackgroundProcessManager;

/** 可手动触发事件的 fake PTY，语义对齐 node-pty（不重放事件） */
class ControlledPty {
  pid = 4242;
  killed = false;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];

  onData = (cb: (data: string) => void) => {
    this.dataListeners.push(cb);
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((l) => l !== cb); } };
  };

  onExit = (cb: (e: { exitCode: number; signal?: number }) => void) => {
    this.exitListeners.push(cb);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((l) => l !== cb); } };
  };

  emitData(data: string) {
    for (const l of [...this.dataListeners]) l(data);
  }

  emitExit(exitCode: number) {
    for (const l of [...this.exitListeners]) l({ exitCode });
  }

  write() {}
  resize() {}
  kill() { this.killed = true; }
}

function spawnResultFor(pty: ControlledPty, earlyEvents: EarlyPtyEvent[] = []) {
  let taken = false;
  return {
    pid: pty.pid,
    pty,
    takeEarlyEvents: () => {
      if (taken) return [];
      taken = true;
      return earlyEvents;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createSessionFixture(options: { providerId?: string } = {}) {
  const project = await prisma.project.create({
    data: { name: 'lifecycle project', repoPath: testDir },
  });
  const task = await prisma.task.create({
    data: { title: 'lifecycle task', projectId: project.id },
  });
  const workspace = await prisma.workspace.create({
    data: {
      taskId: task.id,
      branchName: 'lifecycle',
      worktreePath: testDir,
      status: 'ACTIVE',
    },
  });
  const session = await prisma.session.create({
    data: {
      workspaceId: workspace.id,
      agentType: AgentType.CODEX,
      variant: 'DEFAULT',
      providerId: options.providerId ?? null,
      prompt: 'do something',
      status: SessionStatus.PENDING,
    },
  });
  return { project, task, workspace, session };
}

function waitForEvent(eventBus: EventBus, event: 'session:completed', timeoutMs = 5000): Promise<{ sessionId: string; status: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    eventBus.on(event, (payload) => {
      clearTimeout(timer);
      resolve(payload as { sessionId: string; status: string });
    });
  });
}

describe('SessionManager session status vs real process state', () => {
  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      }
    );

    const utilsModule = await import('../../utils/index.js');
    const sessionManagerModule = await import('../session-manager.js');
    const outputModule = await import('../../output/index.js');
    const backgroundServiceModule = await import('../workspace-background-service.service.js');
    const backgroundManagerModule = await import('../workspace-background-process-manager.js');
    prisma = utilsModule.prisma;
    SessionManager = sessionManagerModule.SessionManager;
    sessionMsgStoreManager = outputModule.sessionMsgStoreManager;
    WorkspaceBackgroundService = backgroundServiceModule.WorkspaceBackgroundService;
    WorkspaceBackgroundProcessManager = backgroundManagerModule.WorkspaceBackgroundProcessManager;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    getProviderByIdMock.mockReturnValue(null);
    getExecutorByProviderMock.mockReset();
    getExecutorByProviderMock.mockImplementation(createMockExecutor);
    clearAgentApiCredentials();
    await prisma.executionProcess.deleteMany();
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  it('requires a Provider runtime supported by the selected Agent before persisting a session', async () => {
    const { workspace } = await createSessionFixture();
    const manager = new SessionManager(new EventBus());

    await expect(manager.create(
      workspace.id,
      AgentType.QWEN_CODE,
      'run qwen without an ACP provider',
    )).rejects.toThrow("Agent 'QWEN_CODE' does not support the 'CLI' runtime");

    getProviderByIdMock.mockReturnValue({
      id: 'qwen-acp-provider',
      name: 'Qwen Code ACP',
      agentType: AgentType.QWEN_CODE,
      runtimeType: 'ACP',
      env: {},
      config: {},
      isDefault: false,
    });
    const created = await manager.create(
      workspace.id,
      AgentType.QWEN_CODE,
      'run qwen through ACP',
      'DEFAULT',
      'qwen-acp-provider',
    );

    expect(created).toMatchObject({
      agentType: AgentType.QWEN_CODE,
      runtimeType: 'ACP',
      providerId: 'qwen-acp-provider',
    });
  });

  it('resolves the latest Provider transport snapshot for every new or retried spawn', async () => {
    const first = await createSessionFixture({ providerId: 'provider-snapshot' });
    const second = await createSessionFixture({ providerId: 'provider-snapshot' });
    const provider = {
      id: 'provider-snapshot',
      name: 'Provider Snapshot',
      agentType: AgentType.CODEX,
      env: {},
      config: { disableResponsesWebsocket: false },
      isDefault: false,
    };
    const executorSnapshots: boolean[] = [];
    getProviderByIdMock.mockImplementation(() => provider);
    getExecutorByProviderMock.mockImplementation(() => {
      const snapshot = provider.config.disableResponsesWebsocket;
      executorSnapshots.push(snapshot);
      return createMockExecutor();
    });
    spawnMock
      .mockResolvedValueOnce(spawnResultFor(new ControlledPty()))
      .mockResolvedValueOnce(spawnResultFor(new ControlledPty()));

    const manager = new SessionManager(new EventBus());
    await manager.start(first.session.id);
    provider.config.disableResponsesWebsocket = true;
    await manager.start(second.session.id);

    expect(getExecutorByProviderMock).toHaveBeenNthCalledWith(1, 'provider-snapshot');
    expect(getExecutorByProviderMock).toHaveBeenNthCalledWith(2, 'provider-snapshot');
    expect(executorSnapshots).toEqual([false, true]);
    manager.destroyAll();
  });

  it('uses one latest Provider snapshot for follow-up resume and its new-session fallback', async () => {
    const provider = {
      id: 'provider-follow-up-snapshot',
      name: 'Provider Follow-up Snapshot',
      agentType: AgentType.CODEX,
      env: {},
      config: { disableResponsesWebsocket: true },
      isDefault: false,
    };
    const observed: Array<{ path: 'resume' | 'fallback'; disabled: boolean }> = [];
    getProviderByIdMock.mockImplementation(() => provider);
    getExecutorByProviderMock.mockImplementation(() => {
      const disabled = provider.config.disableResponsesWebsocket;
      return {
        agentType: AgentType.CODEX,
        displayName: 'Mock Codex',
        getAvailabilityInfo: vi.fn(),
        getCapabilities: vi.fn(() => []),
        spawnFollowUp: vi.fn(async () => {
          observed.push({ path: 'resume', disabled });
          provider.config.disableResponsesWebsocket = false;
          throw new Error('synthetic resume failure');
        }),
        spawn: vi.fn(async () => {
          observed.push({ path: 'fallback', disabled });
          return spawnResultFor(new ControlledPty());
        }),
      };
    });
    const { session } = await createSessionFixture({ providerId: provider.id });
    await prisma.session.update({
      where: { id: session.id },
      data: { logSnapshot: JSON.stringify({ sessionId: 'codex-thread-1', entries: [] }) },
    });

    const manager = new SessionManager(new EventBus());
    await manager.sendMessage(session.id, 'continue with the current provider');

    expect(getExecutorByProviderMock).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([
      { path: 'resume', disabled: true },
      { path: 'fallback', disabled: true },
    ]);
    manager.destroyAll();
  });

  it('marks a reused ACP follow-up RUNNING without a new process event and allows it to stop', async () => {
    const provider = {
      id: 'reused-acp-provider',
      name: 'Reused ACP Provider',
      agentType: AgentType.CODEX,
      runtimeType: 'ACP',
      env: {},
      config: {},
      isDefault: false,
    };
    getProviderByIdMock.mockReturnValue(provider);
    const { session } = await createSessionFixture({ providerId: provider.id });
    await prisma.session.update({
      where: { id: session.id },
      data: {
        runtimeType: 'ACP',
        status: SessionStatus.COMPLETED,
        externalSessionId: 'external-acp-session',
      },
    });

    const completion = new Promise<never>(() => undefined);
    const hasActiveTurn = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const runtimeCoordinator = {
      hasActiveTurn,
      startTurn: vi.fn(async () => ({ turnId: 'turn-2', completion })),
      abandonTurn: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => undefined),
      disposeSession: vi.fn(async () => undefined),
      destroyAll: vi.fn(async () => undefined),
    };
    const manager = new SessionManager(new EventBus());
    (manager as any).runtimeCoordinator = runtimeCoordinator;

    await manager.sendMessage(session.id, 'continue on the reused ACP connection');

    expect(runtimeCoordinator.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      towerSessionId: session.id,
      runtimeType: 'ACP',
      resumeExternalSessionId: 'external-acp-session',
    }));
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status)
      .toBe(SessionStatus.RUNNING);
    expect(await prisma.executionProcess.count({ where: { sessionId: session.id } })).toBe(0);

    // Even if a stale terminal value is observed, an active Runtime turn wins.
    await prisma.session.update({
      where: { id: session.id },
      data: { status: SessionStatus.COMPLETED },
    });
    await manager.stop(session.id);
    expect(runtimeCoordinator.abandonTurn).toHaveBeenCalledWith(session.id);
    expect(runtimeCoordinator.cancelTurn).not.toHaveBeenCalled();
    expect(runtimeCoordinator.disposeSession).toHaveBeenCalledWith(session.id);
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status)
      .toBe(SessionStatus.CANCELLED);
    await manager.destroyAll();
  });

  it('keeps an ACP DriverSession credential valid across completed follow-up and revokes it on stop', async () => {
    const provider = {
      id: 'credential-acp-provider',
      name: 'Credential ACP Provider',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP,
      env: {},
      config: {},
      isDefault: false,
    };
    getProviderByIdMock.mockReturnValue(provider);
    const { workspace, session } = await createSessionFixture({ providerId: provider.id });
    await prisma.session.update({
      where: { id: session.id },
      data: { runtimeType: RuntimeType.ACP },
    });
    const service = new WorkspaceBackgroundService();
    const turns: Array<ReturnType<typeof deferred<RuntimeTurnOutcome>>> = [];
    const observedCredentials: string[] = [];
    let openInput: RuntimeOpenInput | undefined;
    const capabilities: RuntimeCapabilities = {
      loadSession: true,
      terminalInput: false,
      terminalResize: false,
      permissions: true,
    };
    const driverSession: DriverSession = {
      runtimeInstanceId: 'credential-acp-runtime',
      capabilities,
      externalSessionId: 'credential-acp-external',
      runTurn: vi.fn(async (_turn: RuntimeRunTurnInput) => {
        const credential = openInput?.env.get(AGENT_API_CREDENTIAL_ENV) ?? '';
        observedCredentials.push(credential);
        const identity = validateAgentApiCredential(credential);
        if (!identity) throw new Error('ACP workspace-service credential is invalid');
        await service.authorizeCaller(workspace.id, { kind: 'agent', ...identity });
        const completion = deferred<RuntimeTurnOutcome>();
        turns.push(completion);
        return { completion: completion.promise };
      }),
      cancelTurn: vi.fn(async () => {
        turns.at(-1)?.resolve({ stopReason: 'cancelled' });
      }),
      close: vi.fn(async () => undefined),
    };
    const driver: RuntimeDriver = {
      type: RuntimeType.ACP,
      open: vi.fn(async (input) => {
        openInput = input;
        return driverSession;
      }),
    };
    const eventBus = new EventBus();
    const manager = new SessionManager(
      eventBus,
      undefined,
      new StaticRuntimeRegistry([driver]),
    );
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    turns[0].resolve({ stopReason: 'end_turn' });
    await completed;
    await vi.waitFor(() => expect(sessionMsgStoreManager.has(session.id)).toBe(false));

    await manager.sendMessage(session.id, 'use workspace service again');
    expect(observedCredentials).toHaveLength(2);
    expect(observedCredentials[1]).toBe(observedCredentials[0]);
    expect(validateAgentApiCredential(observedCredentials[1]!)).toMatchObject({ sessionId: session.id });

    await manager.stop(session.id);
    expect(driverSession.close).toHaveBeenCalledOnce();
    expect(validateAgentApiCredential(observedCredentials[1]!)).toBeNull();
    await manager.destroyAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('moves the session to COMPLETED with a persisted snapshot when the PTY exits normally', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    expect(manager.hasActivePipeline(session.id)).toBe(true);
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status).toBe(SessionStatus.RUNNING);

    pty.emitData(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }) + '\n');
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'all done' },
    }) + '\n');
    pty.emitExit(0);

    const payload = await completed;
    expect(payload.status).toBe(SessionStatus.COMPLETED);
    expect(manager.hasActivePipeline(session.id)).toBe(false);

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    expect(persisted?.status).toBe(SessionStatus.COMPLETED);
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    expect(snapshot.sessionId).toBe('thread-1');
    expect(snapshot.entries.map((e: { content: string }) => e.content)).toContain('all done');
    // MsgStore 最终释放（handleSessionExit 的收尾步骤在 session:completed 事件之后）
    await vi.waitFor(() => {
      expect(sessionMsgStoreManager.has(session.id)).toBe(false);
    });
  });

  it('keeps a CLI DriverSession credential valid across completed follow-up and revokes it on stop', async () => {
    const { workspace, session } = await createSessionFixture();
    const firstPty = new ControlledPty();
    const secondPty = new ControlledPty();
    spawnMock
      .mockResolvedValueOnce(spawnResultFor(firstPty))
      .mockResolvedValueOnce(spawnResultFor(secondPty));
    const service = new WorkspaceBackgroundService();
    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    const firstCredential = spawnMock.mock.calls[0]?.[0].env.get(AGENT_API_CREDENTIAL_ENV) as string;
    const firstIdentity = validateAgentApiCredential(firstCredential);
    expect(firstIdentity).toMatchObject({ sessionId: session.id, invocationId: null });
    await service.authorizeCaller(workspace.id, { kind: 'agent', ...firstIdentity! });

    firstPty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;
    await vi.waitFor(() => expect(sessionMsgStoreManager.has(session.id)).toBe(false));
    expect(validateAgentApiCredential(firstCredential)).toEqual(firstIdentity);

    await manager.sendMessage(session.id, 'use workspace service again');
    const secondCredential = spawnMock.mock.calls[1]?.[0].env.get(AGENT_API_CREDENTIAL_ENV) as string;
    const secondIdentity = validateAgentApiCredential(secondCredential);
    expect(secondCredential).toBe(firstCredential);
    await service.authorizeCaller(workspace.id, { kind: 'agent', ...secondIdentity! });

    await manager.stop(session.id);
    expect(validateAgentApiCredential(secondCredential)).toBeNull();
    await manager.destroyAll();
  });

  it('coalesces burst patches into a low-frequency checkpoint and still force-flushes the final snapshot', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');
    await manager.start(session.id);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    pty.emitData(JSON.stringify({ type: 'thread.started', thread_id: 'thread-checkpoint' }) + '\n');
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'checkpoint one' },
    }) + '\n');
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm2', type: 'agent_message', text: 'checkpoint two' },
    }) + '\n');

    const checkpointTimers = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 15_000);
    expect(checkpointTimers).toHaveLength(1);
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.logSnapshot).toBeNull();

    const flushSnapshot = (
      manager as unknown as { flushSnapshotPersist(sessionId: string): Promise<void> }
    ).flushSnapshotPersist.bind(manager);
    await flushSnapshot(session.id);
    setTimeoutSpy.mockRestore();

    const checkpointed = await prisma.session.findUnique({ where: { id: session.id } });
    const checkpointedSnapshot = JSON.parse(checkpointed?.logSnapshot ?? '{}');
    expect(checkpointedSnapshot.entries.map((entry: { content: string }) => entry.content)).toEqual(
      expect.arrayContaining(['checkpoint one', 'checkpoint two']),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushSnapshot(session.id);
    const unchanged = await prisma.session.findUnique({ where: { id: session.id } });
    expect(unchanged?.updatedAt.getTime()).toBe(checkpointed?.updatedAt.getTime());

    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm3', type: 'agent_message', text: 'final only' },
    }) + '\n');
    pty.emitExit(0);
    await completed;

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    expect(persisted?.status).toBe(SessionStatus.COMPLETED);
    const finalSnapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    expect(finalSnapshot.entries.map((entry: { content: string }) => entry.content)).toContain('final only');
  });

  it('completes on turn.completed before a slow PTY exit and cleans it in the background', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'fast logical completion' },
    }) + '\n');
    pty.emitData(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 2, output_tokens: 3 },
    }) + '\n');

    const payload = await completed;
    expect(payload.status).toBe(SessionStatus.COMPLETED);
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status)
      .toBe(SessionStatus.COMPLETED);
    expect(manager.hasActiveTurn(session.id)).toBe(false);

    await vi.waitFor(() => {
      expect(pty.killed).toBe(true);
      expect(manager.hasActiveTurn(session.id)).toBe(false);
    }, { timeout: 2000 });

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    expect(snapshot.entries.map((entry: { content: string }) => entry.content))
      .toContain('fast logical completion');
  });

  it('waits for the completed generation auto-commit before starting an immediate follow-up', async () => {
    const { session } = await createSessionFixture();
    const firstPty = new ControlledPty();
    const secondPty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(firstPty)).mockResolvedValueOnce(spawnResultFor(secondPty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');
    let releaseAutoCommit!: () => void;
    const autoCommit = new Promise<void>((resolve) => { releaseAutoCommit = resolve; });
    const autoCommitSpy = vi.spyOn(manager as any, 'autoCommitChanges').mockReturnValue(autoCommit);
    const waitForAutoCommitSpy = vi.spyOn(manager as any, 'waitForPendingAutoCommit');

    await manager.start(session.id);
    waitForAutoCommitSpy.mockClear();
    firstPty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'first turn' },
    }) + '\n');
    firstPty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;

    const followUp = manager.sendMessage(session.id, 'follow-up');
    await vi.waitFor(() => {
      expect(waitForAutoCommitSpy).toHaveBeenCalledWith(session.id);
      expect(autoCommitSpy).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    releaseAutoCommit();
    await followUp;
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(autoCommitSpy.mock.calls[0]?.[0]).toBe(session.id);
    expect(autoCommitSpy.mock.calls[0]?.[1]).toBe(1);
  });

  it('writes a delayed follow-up into the new MsgStore after the completed store was released', async () => {
    const { session } = await createSessionFixture();
    const firstPty = new ControlledPty();
    const secondPty = new ControlledPty();
    spawnMock
      .mockResolvedValueOnce(spawnResultFor(firstPty))
      .mockResolvedValueOnce(spawnResultFor(secondPty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const firstCompleted = waitForEvent(eventBus, 'session:completed');
    await manager.start(session.id);
    firstPty.emitData(JSON.stringify({ type: 'thread.started', thread_id: 'thread-delayed' }) + '\n');
    firstPty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'first response' },
    }) + '\n');
    firstPty.emitExit(0);
    await firstCompleted;
    await vi.waitFor(() => expect(sessionMsgStoreManager.has(session.id)).toBe(false));

    await manager.sendMessage(session.id, 'delayed follow-up');
    const secondCompleted = waitForEvent(eventBus, 'session:completed');
    secondPty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm2', type: 'agent_message', text: 'second response' },
    }) + '\n');
    secondPty.emitExit(0);
    await secondCompleted;

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    expect(snapshot.entries.map((entry: { content: string }) => entry.content)).toEqual(
      expect.arrayContaining(['first response', 'delayed follow-up', 'second response']),
    );
  });

  it('accepts a follow-up that explicitly reuses the session provider', async () => {
    const provider = {
      id: 'same-provider',
      name: 'Same provider',
      agentType: AgentType.CODEX,
      env: {},
      config: {},
      isDefault: false,
    };
    const executor = {
      agentType: AgentType.CODEX,
      displayName: 'Mock Codex',
      getAvailabilityInfo: vi.fn(),
      getCapabilities: vi.fn(() => []),
      spawn: spawnMock,
    };
    getProviderByIdMock.mockReturnValue(provider);
    getExecutorByProviderMock.mockReturnValue(executor);

    const { session } = await createSessionFixture({ providerId: provider.id });
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const manager = new SessionManager(new EventBus());
    await manager.sendMessage(session.id, 'reuse provider', provider.id);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      providerId: provider.id,
      status: SessionStatus.RUNNING,
    });
    manager.destroyAll();
  });

  it('keeps completed-turn post-processing alive when a follow-up provider was deleted', async () => {
    const { task, workspace, session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');
    let releaseAutoCommit!: () => void;
    const autoCommit = new Promise<void>((resolve) => { releaseAutoCommit = resolve; });
    const autoCommitSpy = vi.spyOn(manager as any, 'autoCommitChanges').mockReturnValue(autoCommit);
    const reconcileSpy = vi
      .spyOn((manager as any).teamReconciler, 'handleSessionExit')
      .mockResolvedValue(false);
    const commitMessageSpy = vi
      .spyOn(manager as any, 'triggerCommitMessageGeneration')
      .mockImplementation(() => {});

    await manager.start(session.id);
    pty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;

    await expect(manager.sendMessage(session.id, 'follow-up', 'deleted-provider'))
      .rejects.toThrow('Provider not found: deleted-provider');
    expect(autoCommitSpy).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    releaseAutoCommit();
    await vi.waitFor(async () => {
      expect(reconcileSpy).toHaveBeenCalledWith(session.id);
      expect((await prisma.task.findUnique({ where: { id: task.id } }))?.status)
        .toBe(TaskStatus.IN_REVIEW);
      expect(commitMessageSpy).toHaveBeenCalledWith(workspace.id);
    });
  });

  it('keeps completed-turn post-processing alive when the session provider was deleted and omitted', async () => {
    const { task, workspace, session } = await createSessionFixture({ providerId: 'deleted-provider' });
    const pty = new ControlledPty();
    const executor = {
      agentType: AgentType.CODEX,
      displayName: 'Mock Codex',
      getAvailabilityInfo: vi.fn(),
      getCapabilities: vi.fn(() => []),
      spawn: spawnMock,
    };
    getExecutorByProviderMock.mockReturnValue(executor);
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');
    let releaseAutoCommit!: () => void;
    const autoCommit = new Promise<void>((resolve) => { releaseAutoCommit = resolve; });
    const autoCommitSpy = vi.spyOn(manager as any, 'autoCommitChanges').mockReturnValue(autoCommit);
    const reconcileSpy = vi
      .spyOn((manager as any).teamReconciler, 'handleSessionExit')
      .mockResolvedValue(false);
    const commitMessageSpy = vi
      .spyOn(manager as any, 'triggerCommitMessageGeneration')
      .mockImplementation(() => {});

    await manager.start(session.id);
    pty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;

    await expect(manager.sendMessage(session.id, 'follow-up')).rejects
      .toThrow('Provider not found: deleted-provider');
    expect(autoCommitSpy).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    releaseAutoCommit();
    await vi.waitFor(async () => {
      expect(reconcileSpy).toHaveBeenCalledWith(session.id);
      expect((await prisma.task.findUnique({ where: { id: task.id } }))?.status)
        .toBe(TaskStatus.IN_REVIEW);
      expect(commitMessageSpy).toHaveBeenCalledWith(workspace.id);
    });
  });

  it('holds reconciliation while valid follow-up provider validation is delayed', async () => {
    const provider = {
      id: 'delayed-provider',
      name: 'Delayed provider',
      agentType: AgentType.CODEX,
      env: {},
      config: {},
      isDefault: false,
    };
    const executor = {
      agentType: AgentType.CODEX,
      displayName: 'Mock Codex',
      getAvailabilityInfo: vi.fn(),
      getCapabilities: vi.fn(() => []),
      spawn: spawnMock,
    };
    getProviderByIdMock.mockReturnValue(provider);
    getExecutorByProviderMock.mockReturnValue(executor);

    const { session } = await createSessionFixture({ providerId: provider.id });
    const firstPty = new ControlledPty();
    const secondPty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(firstPty)).mockResolvedValueOnce(spawnResultFor(secondPty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');
    const autoCommitSpy = vi.spyOn(manager as any, 'autoCommitChanges').mockResolvedValue(undefined);
    const reconcileSpy = vi
      .spyOn((manager as any).teamReconciler, 'handleSessionExit')
      .mockResolvedValue(false);

    await manager.start(session.id);
    firstPty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;

    const originalFind = (manager as any).findSessionExecutionRecord.bind(manager);
    let releaseValidation!: () => void;
    let markValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => { markValidationStarted = resolve; });
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    vi.spyOn(manager as any, 'findSessionExecutionRecord').mockImplementation(async (...args: unknown[]) => {
      const sessionId = args[0] as string;
      if (sessionId === session.id) {
        markValidationStarted();
        await validationGate;
      }
      return originalFind(sessionId);
    });

    const followUp = manager.sendMessage(session.id, 'delayed follow-up', provider.id);
    await validationStarted;
    await vi.waitFor(() => expect(autoCommitSpy).toHaveBeenCalledTimes(1));
    expect(reconcileSpy).not.toHaveBeenCalled();

    releaseValidation();
    await followUp;
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    manager.destroyAll();
  });

  it('keeps turn.failed terminal when the wrapper exits with code 0', async () => {
    const { task, session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    pty.emitData(JSON.stringify({
      type: 'turn.failed',
      error: { message: 'rate limited' },
    }) + '\n');

    const payload = await completed;
    expect(payload.status).toBe(SessionStatus.FAILED);
    pty.emitExit(0);

    await vi.waitFor(async () => {
      expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status)
        .toBe(SessionStatus.FAILED);
    });
    // The session's task remains in progress; a failed turn must not trigger
    // the success-only Task -> IN_REVIEW transition.
    expect((await prisma.task.findUnique({ where: { id: task.id } }))?.status).not.toBe('IN_REVIEW');
    expect(manager.hasActivePipeline(session.id)).toBe(false);
  });

  it('stops the residual PTY without regressing a logically completed session', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'done before stop' },
    }) + '\n');
    pty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;

    await manager.stop(session.id);

    expect(pty.killed).toBe(true);
    expect(manager.hasActivePipeline(session.id)).toBe(false);
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status)
      .toBe(SessionStatus.COMPLETED);
  });

  it('marks the session FAILED when the PTY exits non-zero with only stderr noise', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    pty.emitData('ERROR: unauthorized\n');
    pty.emitExit(1);

    const payload = await completed;
    expect(payload.status).toBe(SessionStatus.FAILED);

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    expect(persisted?.status).toBe(SessionStatus.FAILED);
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    const errorEntries = snapshot.entries.filter((e: { entryType: string }) => e.entryType === 'error_message');
    expect(errorEntries).toHaveLength(1);
    expect(errorEntries[0].content).toContain('unauthorized');
  });

  it('does not leave the session RUNNING when the process exits before the pipeline attaches (early-exit race)', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    // 进程在 spawn 返回后立刻输出错误并退出 —— 事件发生于 attachPipeline 之前，
    // 由 executor 缓存、pipeline 构造时重放
    spawnMock.mockResolvedValueOnce(
      spawnResultFor(pty, [
        { type: 'data', data: 'codex: fatal startup error\n' },
        { type: 'exit', exitCode: 2 },
      ])
    );

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    const payload = await completed;

    expect(payload.status).toBe(SessionStatus.FAILED);
    expect(manager.hasActivePipeline(session.id)).toBe(false);
    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    expect(persisted?.status).toBe(SessionStatus.FAILED);
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    const errorEntries = snapshot.entries.filter((e: { entryType: string }) => e.entryType === 'error_message');
    expect(errorEntries.length).toBeGreaterThan(0);
    expect(errorEntries[0].content).toContain('fatal startup error');
  });

  it('stop() cancels the session, persists the snapshot and releases the MsgStore', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);

    await manager.start(session.id);
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'partial work' },
    }) + '\n');

    await manager.stop(session.id);

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    expect(persisted?.status).toBe(SessionStatus.CANCELLED);
    expect(manager.hasActivePipeline(session.id)).toBe(false);
    expect(pty.killed).toBe(true);
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    expect(snapshot.entries.map((e: { content: string }) => e.content)).toContain('partial work');
    expect(sessionMsgStoreManager.has(session.id)).toBe(false);
  });

  it('keeps a real workspace service alive through SessionManager and CLI disposal', async () => {
    const { workspace, session } = await createSessionFixture();
    const backgroundManager = new WorkspaceBackgroundProcessManager({
      resolveCommand: async () => process.execPath,
    });
    const backgroundService = new WorkspaceBackgroundService(backgroundManager);
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));
    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    let started: Awaited<ReturnType<InstanceType<typeof WorkspaceBackgroundService>['start']>> | null = null;

    try {
      started = await backgroundService.start(workspace.id, 'web', {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      });
      const completed = waitForEvent(eventBus, 'session:completed');
      await manager.start(session.id);
      pty.emitExit(0);
      await completed;

      expect(backgroundManager.has(started.id, started.runtimeInstanceId)).toBe(true);
      await manager.stop(session.id);

      expect(backgroundManager.has(started.id, started.runtimeInstanceId)).toBe(true);
      await expect(backgroundService.list(workspace.id)).resolves.toEqual([
        expect.objectContaining({ runtimeState: 'RUNNING' }),
      ]);
    } finally {
      await manager.destroyAll();
      if (started) await backgroundService.stop(workspace.id, 'web').catch(() => undefined);
      await backgroundManager.stopAll().catch(() => undefined);
    }
  }, 15_000);
});
