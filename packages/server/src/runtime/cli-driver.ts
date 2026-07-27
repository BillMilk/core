import { randomUUID } from 'node:crypto';
import { RuntimeType } from '@agent-tower/shared';
import { EventBus } from '../core/event-bus.js';
import {
  getExecutor,
  getExecutorByProvider,
  ExecutorConfigurationError,
  ExecutorNotFoundError,
  normalizeExecutorStartError,
  type BaseExecutor,
  type CancellationToken,
  type SpawnedChild,
} from '../executors/index.js';
import { AgentPipeline } from '../pipeline/agent-pipeline.js';
import { AgentType } from '../types/index.js';
import type {
  DriverSession,
  DriverTurn,
  RuntimeDriver,
  RuntimeDriverEventSink,
  RuntimeOpenInput,
  RuntimeRunTurnInput,
  RuntimeTurnOutcome,
} from './contracts.js';
import { AgentRuntimeError } from './errors.js';
import { createCliParser } from './cli-parser.js';

const LOGICAL_COMPLETION_GRACE_MS = 250;
const PROCESS_EXIT_LISTENER_TIMEOUT_MS = 5_000;

interface ActiveCliTurn {
  turnId: string;
  runtimeInstanceId: string;
  pipeline?: AgentPipeline;
  cancel?: CancellationToken;
  completion: Promise<RuntimeTurnOutcome>;
  resolve: (outcome: RuntimeTurnOutcome) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  processExited: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  processExitTimer?: ReturnType<typeof setTimeout>;
  offRawExit?: { dispose(): void };
  cleanups: Array<() => void>;
}

export class CliRuntimeDriver implements RuntimeDriver {
  readonly type = RuntimeType.CLI;

  async open(input: RuntimeOpenInput): Promise<DriverSession> {
    return new CliDriverSession(input);
  }
}

class CliDriverSession implements DriverSession {
  readonly capabilities = {
    loadSession: true,
    terminalInput: true,
    terminalResize: true,
    permissions: false,
  };
  private active?: ActiveCliTurn;
  private currentRuntimeInstanceId = randomUUID();
  private currentExternalSessionId?: string;
  private closed = false;

  constructor(private readonly input: RuntimeOpenInput) {
    this.currentExternalSessionId = input.externalSessionId ?? undefined;
  }

  get runtimeInstanceId(): string {
    return this.currentRuntimeInstanceId;
  }

  get externalSessionId(): string | undefined {
    return this.currentExternalSessionId;
  }

  async runTurn(input: RuntimeRunTurnInput, sink: RuntimeDriverEventSink): Promise<DriverTurn> {
    if (this.closed) {
      throw new AgentRuntimeError('runtime_disposed', 'prompt', 'CLI runtime session is closed', true);
    }
    if (this.active && !this.active.settled) {
      throw new AgentRuntimeError('turn_already_running', 'prompt', 'CLI turn is already running', false);
    }
    this.cleanupActive();

    const executor = this.resolveExecutor();
    const spawnConfig = {
      workingDir: this.input.workingDir,
      prompt: input.prompt,
      env: this.input.env,
    };
    let spawnResult: SpawnedChild;
    try {
      const resumeId = input.resumeExternalSessionId ?? this.currentExternalSessionId;
      if (resumeId && executor.spawnFollowUp) {
        try {
          spawnResult = await executor.spawnFollowUp(spawnConfig, resumeId);
        } catch {
          spawnResult = await executor.spawn(spawnConfig);
        }
      } else {
        spawnResult = await executor.spawn(spawnConfig);
      }
    } catch (error) {
      throw normalizeExecutorStartError(error);
    }

    this.currentRuntimeInstanceId = randomUUID();
    const active = createActiveTurn(input.turnId, this.currentRuntimeInstanceId);
    this.active = active;

    try {
      await sink.process({
        type: 'started',
        runtimeInstanceId: active.runtimeInstanceId,
        pid: spawnResult.pid,
      });
      this.attachSpawnedTurn(active, spawnResult, input.msgStore, sink);
    } catch (error) {
      void active.completion.catch(() => undefined);
      try {
        spawnResult.cancel?.cancel();
        spawnResult.pty.kill();
      } catch {
        // The host error remains authoritative.
      }
      this.settleFailure(active, error);
      throw error;
    }

    return { completion: active.completion };
  }

  async cancelTurn(turnId: string): Promise<void> {
    const active = this.active;
    if (!active || active.turnId !== turnId) return;
    active.cancel?.cancel();
    active.pipeline?.destroy();
    this.settleFailure(
      active,
      new AgentRuntimeError('turn_cancelled', 'cancel', 'CLI turn was cancelled', true),
    );
  }

  writeInput(data: string): void {
    this.active?.pipeline?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.active?.pipeline?.resize(cols, rows);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = this.active;
    if (!active) return;
    active.cancel?.cancel();
    active.pipeline?.destroy();
    this.settleFailure(
      active,
      new AgentRuntimeError('runtime_disposed', 'close', 'CLI runtime session was closed', true),
    );
    await Promise.race([
      active.completion.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    this.cleanupActive();
  }

  private attachSpawnedTurn(
    active: ActiveCliTurn,
    spawnResult: SpawnedChild,
    msgStore: RuntimeRunTurnInput['msgStore'],
    sink: RuntimeDriverEventSink,
  ): void {
    const bus = new EventBus();
    const onStdout = ({ data }: { sessionId: string; data: string }) => sink.stream({ type: 'stdout', data });
    const onPatch = ({ patch, seq }: { sessionId: string; patch: unknown[]; seq: number }) => {
      sink.stream({ type: 'conversation_patch', patch: patch as never, seq });
    };
    const onSessionId = ({ agentSessionId }: { sessionId: string; agentSessionId: string }) => {
      this.currentExternalSessionId = agentSessionId;
      sink.stream({ type: 'external_session_id', externalSessionId: agentSessionId });
    };
    const onCompleted = () => {
      this.settleSuccess(active, {});
      this.schedulePipelineCleanup(active);
    };
    const onFailed = () => {
      this.settleFailure(
        active,
        new AgentRuntimeError('turn_failed', 'prompt', 'CLI agent reported a failed turn', true),
      );
      this.schedulePipelineCleanup(active);
    };
    const onExit = ({ exitCode }: { sessionId: string; exitCode?: number }) => {
      if (typeof exitCode === 'number' && exitCode !== 0) {
        this.settleFailure(
          active,
          new AgentRuntimeError('process_exit', 'runtime', `CLI process exited with code ${exitCode}`, true),
        );
      } else {
        this.settleSuccess(active, {});
      }
      this.cleanupTurnResources(active);
    };

    bus.on('session:stdout', onStdout);
    bus.on('session:patch', onPatch);
    bus.on('session:sessionId', onSessionId);
    bus.on('session:turn-completed', onCompleted);
    bus.on('session:turn-failed', onFailed);
    bus.on('session:exit', onExit);
    active.cleanups.push(
      () => bus.off('session:stdout', onStdout),
      () => bus.off('session:patch', onPatch),
      () => bus.off('session:sessionId', onSessionId),
      () => bus.off('session:turn-completed', onCompleted),
      () => bus.off('session:turn-failed', onFailed),
      () => bus.off('session:exit', onExit),
    );

    let processExitReported = false;
    const reportProcessExit = (exitCode: number, signal?: NodeJS.Signals | null) => {
      if (processExitReported) return;
      processExitReported = true;
      active.processExited = true;
      void sink.process({
        type: 'exited',
        runtimeInstanceId: active.runtimeInstanceId,
        exitCode,
        signal,
      }).finally(() => this.cleanupRawExitTracking(active));
    };
    active.offRawExit = spawnResult.pty.onExit(({ exitCode, signal }) => {
      reportProcessExit(exitCode, signal as NodeJS.Signals | null | undefined);
    });

    const earlyEvents = spawnResult.takeEarlyEvents?.() ?? [];
    const earlyExit = earlyEvents.find((event) => event.type === 'exit');
    if (earlyExit?.type === 'exit') reportProcessExit(earlyExit.exitCode);

    const parser = createCliParser(this.input.agentType as AgentType, this.input.workingDir, msgStore);
    const pipeline = new AgentPipeline(
      this.input.towerSessionId,
      spawnResult.pty,
      parser,
      msgStore,
      bus,
      earlyEvents,
    );
    active.pipeline = pipeline;
    active.cancel = spawnResult.cancel;
    if (!pipeline.isAlive) this.cleanupTurnResources(active);
  }

  private resolveExecutor(): BaseExecutor {
    const agentType = this.input.agentType as AgentType;
    let executor: BaseExecutor | undefined;
    try {
      executor = this.input.providerId
        ? getExecutorByProvider(this.input.providerId)
        : getExecutor(agentType, this.input.variant);
    } catch (error) {
      throw new ExecutorConfigurationError(agentType, error, this.input.providerId);
    }
    if (!executor) {
      throw new ExecutorNotFoundError(agentType, this.input.providerId);
    }
    return executor;
  }

  private settleSuccess(active: ActiveCliTurn, outcome: RuntimeTurnOutcome): void {
    if (active.settled) return;
    active.settled = true;
    active.resolve(outcome);
  }

  private settleFailure(active: ActiveCliTurn, error: unknown): void {
    if (active.settled) return;
    active.settled = true;
    active.reject(error);
  }

  private schedulePipelineCleanup(active: ActiveCliTurn): void {
    if (active.cleanupTimer) return;
    active.cleanupTimer = setTimeout(() => {
      active.cleanupTimer = undefined;
      active.pipeline?.destroy();
      this.cleanupTurnResources(active);
    }, LOGICAL_COMPLETION_GRACE_MS);
    active.cleanupTimer.unref?.();
  }

  private cleanupTurnResources(active: ActiveCliTurn): void {
    if (active.cleanupTimer) clearTimeout(active.cleanupTimer);
    active.cleanupTimer = undefined;
    for (const cleanup of active.cleanups.splice(0)) cleanup();
    active.pipeline = undefined;
    active.cancel = undefined;
    if (active.processExited) {
      this.cleanupRawExitTracking(active);
    } else {
      this.scheduleRawExitCleanup(active);
    }
  }

  private scheduleRawExitCleanup(active: ActiveCliTurn): void {
    if (!active.offRawExit || active.processExitTimer) return;
    active.processExitTimer = setTimeout(() => {
      active.processExitTimer = undefined;
      this.cleanupRawExitTracking(active);
    }, PROCESS_EXIT_LISTENER_TIMEOUT_MS);
    active.processExitTimer.unref?.();
  }

  private cleanupRawExitTracking(active: ActiveCliTurn): void {
    if (active.processExitTimer) clearTimeout(active.processExitTimer);
    active.processExitTimer = undefined;
    active.offRawExit?.dispose();
    active.offRawExit = undefined;
  }

  private cleanupActive(): void {
    const active = this.active;
    if (!active) return;
    active.pipeline?.destroy();
    this.cleanupTurnResources(active);
    this.active = undefined;
  }
}

function createActiveTurn(turnId: string, runtimeInstanceId: string): ActiveCliTurn {
  let resolve!: (outcome: RuntimeTurnOutcome) => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<RuntimeTurnOutcome>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    turnId,
    runtimeInstanceId,
    completion,
    resolve,
    reject,
    settled: false,
    processExited: false,
    cleanups: [],
  };
}
