import { AgentType, RuntimeType } from '@agent-tower/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionEnv } from '../../executors/execution-env.js';
import { MsgStore, type NormalizedEntry } from '../../output/index.js';
import type { RuntimeDriverEventSink } from '../contracts.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const acpState = vi.hoisted(() => ({
  loadUpdates: [] as Array<{ sessionId: string; update: Record<string, unknown> }>,
  supportsResume: true,
  notificationHandler: undefined as undefined | ((request: { params: unknown }) => Promise<void>),
  prompt: undefined as undefined | {
    promise: Promise<{ stopReason?: string }>;
    resolve: (value: { stopReason?: string }) => void;
    reject: (error: unknown) => void;
  },
  request: undefined as unknown as ReturnType<typeof vi.fn>,
  notify: undefined as unknown as ReturnType<typeof vi.fn>,
  close: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@agentclientprotocol/sdk', () => {
  const methods = {
    agent: {
      initialize: 'initialize',
      session: {
        cancel: 'session/cancel',
        load: 'session/load',
        new: 'session/new',
        prompt: 'session/prompt',
        resume: 'session/resume',
        setConfigOption: 'session/set_config_option',
        setMode: 'session/set_mode',
      },
    },
    client: {
      session: {
        requestPermission: 'session/request_permission',
        update: 'session/update',
      },
    },
  };
  acpState.request = vi.fn(async (method: string) => {
    if (method === methods.agent.initialize) {
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: acpState.supportsResume ? { resume: {} } : {},
        },
      };
    }
    if (method === methods.agent.session.load) {
      for (const params of acpState.loadUpdates) {
        await acpState.notificationHandler?.({ params });
      }
      return {};
    }
    if (method === methods.agent.session.new) return { sessionId: 'external-new' };
    if (method === methods.agent.session.prompt) return acpState.prompt?.promise;
    return {};
  });
  acpState.notify = vi.fn(async (method: string) => {
    if (method === methods.agent.session.cancel) {
      acpState.prompt?.reject(new Error('ACP connection closed'));
    }
  });
  acpState.close = vi.fn();
  const connection = {
    agent: { request: acpState.request, notify: acpState.notify },
    close: acpState.close,
    closed: new Promise<void>(() => undefined),
  };
  const app = {
    onNotification: vi.fn((_method: string, handler: typeof acpState.notificationHandler) => {
      acpState.notificationHandler = handler;
      return app;
    }),
    onRequest: vi.fn(() => app),
    connect: vi.fn(() => connection),
  };
  return {
    PROTOCOL_VERSION: 1,
    methods,
    client: vi.fn(() => app),
    ndJsonStream: vi.fn(() => ({})),
  };
});

vi.mock('../acp/process-manager.js', () => ({
  AcpProcessManager: class {
    async start() {
      return { pid: 123, input: {}, output: {} };
    }
    onExit() {}
    async stop() {}
  },
}));

import { AcpRuntimeDriver } from '../acp/acp-driver.js';

function setup() {
  const sink: RuntimeDriverEventSink = {
    stream: vi.fn(),
    process: vi.fn(async () => undefined),
  };
  const input = {
    towerSessionId: 'tower-1',
    agentType: AgentType.CODEX,
    runtimeType: RuntimeType.ACP,
    variant: 'DEFAULT',
    workingDir: process.cwd(),
    env: ExecutionEnv.default(process.cwd()).set('CODEX_PATH', process.execPath),
    externalSessionId: 'external-1',
  };
  return { sink, input };
}

beforeEach(() => {
  vi.clearAllMocks();
  acpState.loadUpdates = [];
  acpState.supportsResume = true;
  acpState.notificationHandler = undefined;
  acpState.prompt = deferred<{ stopReason?: string }>();
});

describe('AcpRuntimeDriver lifecycle', () => {
  it('reconciles session/load history with one entries patch', async () => {
    const { sink, input } = setup();
    const stableMessageId = `acp-message-${Buffer.from('message-1').toString('base64url')}`;
    const localEntries: NormalizedEntry[] = [
      { id: 'local-user', timestamp: 1, entryType: 'user_message', content: 'continue' },
      { id: stableMessageId, timestamp: 2, entryType: 'assistant_message', content: 'part' },
    ];
    acpState.loadUpdates = [{
      sessionId: 'external-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-1',
        content: { type: 'text', text: 'partial response completed' },
      },
    }];
    const msgStore = new MsgStore();
    msgStore.restoreFromSnapshot({ sessionId: 'external-1', entries: localEntries, seq: 4 });
    const session = await new AcpRuntimeDriver().open(input, sink);

    const turn = await session.runTurn({
      turnId: 'turn-1',
      prompt: 'continue',
      msgStore,
      resumeExternalSessionId: 'external-1',
    }, sink);

    const patches = vi.mocked(sink.stream).mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'conversation_patch');
    expect(patches).toHaveLength(2);
    expect(patches[1]).toMatchObject({
      patch: [{ op: 'replace', path: '/entries' }],
    });
    expect(msgStore.getSnapshot().entries).toEqual([
      localEntries[0],
      { ...localEntries[1], content: 'partial response completed' },
    ]);

    await session.cancelTurn('turn-1');
    await turn.completion;
    await session.close();
  });

  it('uses session/resume for a context-only follow-up', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const msgStore = new MsgStore();

    const turn = await session.runTurn({
      turnId: 'turn-resume',
      prompt: 'continue in a new Tower session',
      msgStore,
      resumeExternalSessionId: 'external-1',
      resumeMode: 'resume',
    }, sink);

    const methods = vi.mocked(acpState.request).mock.calls.map(([method]) => method);
    expect(methods).toContain('session/resume');
    expect(methods).not.toContain('session/load');
    expect(msgStore.getSnapshot().entries).toEqual([]);

    await session.cancelTurn('turn-resume');
    await turn.completion;
    await session.close();
  });

  it('falls back to session/load without importing history when resume is unsupported', async () => {
    acpState.supportsResume = false;
    acpState.loadUpdates = [{
      sessionId: 'external-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'old-message',
        content: { type: 'text', text: 'old response' },
      },
    }];
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const msgStore = new MsgStore();

    const turn = await session.runTurn({
      turnId: 'turn-fallback',
      prompt: 'continue with a legacy agent',
      msgStore,
      resumeExternalSessionId: 'external-1',
      resumeMode: 'resume',
    }, sink);

    const methods = vi.mocked(acpState.request).mock.calls.map(([method]) => method);
    expect(methods).toContain('session/load');
    expect(methods).not.toContain('session/resume');
    expect(msgStore.getSnapshot().entries).toEqual([]);

    await session.cancelTurn('turn-fallback');
    await turn.completion;
    await session.close();
  });

  it('treats an expected cancel rejection as cancelled and reuses the connection', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const firstStore = new MsgStore();
    const first = await session.runTurn({
      turnId: 'turn-1',
      prompt: 'first',
      msgStore: firstStore,
      resumeExternalSessionId: 'external-1',
    }, sink);

    await session.cancelTurn('turn-1');
    await expect(first.completion).resolves.toEqual({ stopReason: 'cancelled' });
    expect(firstStore.getSnapshot().entries).toEqual([]);
    expect(acpState.close).not.toHaveBeenCalled();

    acpState.prompt = deferred<{ stopReason?: string }>();
    const second = await session.runTurn({
      turnId: 'turn-2',
      prompt: 'second',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);
    acpState.prompt.resolve({ stopReason: 'end_turn' });
    await expect(second.completion).resolves.toEqual({ stopReason: 'end_turn' });

    const methods = vi.mocked(acpState.request).mock.calls.map(([method]) => method);
    expect(methods.filter((method) => method === 'session/load')).toHaveLength(1);
    expect(methods.filter((method) => method === 'session/prompt')).toHaveLength(2);
    await session.close();
  });
});
