import { randomUUID } from 'node:crypto';
import {
  RuntimeType,
  type RuntimePermissionRequest,
  type RuntimeStateDto,
  type RuntimeTurnState,
} from '@agent-tower/shared';
import type {
  DriverSession,
  RuntimeCoordinatorHost,
  RuntimeDriverEventSink,
  RuntimeProcessEvent,
  RuntimeRegistry,
  RuntimeStreamEvent,
  RuntimeTurnEventEnvelope,
  RuntimeTurnHandle,
  RuntimeTurnOutcome,
  StartRuntimeTurnInput,
} from './contracts.js';
import { AgentRuntimeError, toRuntimeError } from './errors.js';

interface ActiveTurn {
  id: string;
  sequence: number;
  terminal: boolean;
  completion: Promise<RuntimeTurnOutcome>;
  resolve: (outcome: RuntimeTurnOutcome) => void;
  reject: (error: unknown) => void;
}

interface ManagedRuntimeSession {
  runtimeType: RuntimeType;
  driverSession: DriverSession;
  turnState: RuntimeTurnState;
  activeTurn?: ActiveTurn;
  pendingPermissions: Map<string, RuntimePermissionRequest>;
  lastActivityAt: string;
  error?: ReturnType<typeof toRuntimeError>;
}

export class RuntimeCoordinator {
  private readonly sessions = new Map<string, ManagedRuntimeSession>();
  private readonly opening = new Map<string, Promise<ManagedRuntimeSession>>();
  private destroying = false;

  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly host: RuntimeCoordinatorHost,
  ) {}

  async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeTurnHandle> {
    if (this.destroying) {
      throw new AgentRuntimeError('runtime_disposed', 'open', 'Runtime coordinator is shutting down', true);
    }
    const session = await this.getOrOpen(input);
    if (session.activeTurn) {
      throw new AgentRuntimeError(
        'turn_already_running',
        'prompt',
        `Session '${input.towerSessionId}' already has an active turn`,
        false,
      );
    }

    const turnId = randomUUID();
    let resolveCompletion!: (outcome: RuntimeTurnOutcome) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<RuntimeTurnOutcome>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const active: ActiveTurn = {
      id: turnId,
      sequence: 0,
      terminal: false,
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion,
    };
    session.activeTurn = active;
    session.turnState = 'RUNNING';
    delete session.error;
    this.touch(input.towerSessionId, session);

    const sink = this.createSink(input.towerSessionId, session, active);
    try {
      const driverTurn = await session.driverSession.runTurn({
        turnId,
        prompt: input.prompt,
        msgStore: input.msgStore,
        resumeExternalSessionId: input.resumeExternalSessionId,
        resumeMode: input.resumeMode,
      }, sink);
      void driverTurn.completion.then(
        (outcome) => {
          if (!this.isCurrentTurn(session, active)) {
            resolveCompletion(outcome);
            return;
          }
          this.emitTerminal(input.towerSessionId, session, active, { type: 'completed', outcome });
          resolveCompletion(outcome);
        },
        (error) => {
          if (!this.isCurrentTurn(session, active)) {
            rejectCompletion(error);
            return;
          }
          const normalized = toRuntimeError(error, 'prompt');
          session.error = normalized;
          this.emitTerminal(input.towerSessionId, session, active, { type: 'failed', error: normalized });
          rejectCompletion(error);
        },
      );
    } catch (error) {
      if (this.isCurrentTurn(session, active)) {
        session.activeTurn = undefined;
        session.turnState = 'IDLE';
        session.error = toRuntimeError(error, 'prompt');
        this.invalidatePermissions(input.towerSessionId, session, active.id);
        this.touch(input.towerSessionId, session);
      }
      rejectCompletion(error);
      completion.catch(() => undefined);
      throw error;
    }

    return { turnId, completion };
  }

  async cancelTurn(towerSessionId: string): Promise<void> {
    const pendingOpen = this.opening.get(towerSessionId);
    if (pendingOpen) await pendingOpen.catch(() => undefined);
    const session = this.sessions.get(towerSessionId);
    const active = session?.activeTurn;
    if (!session || !active) return;
    session.turnState = 'CANCELLING';
    this.invalidatePermissions(towerSessionId, session, active.id);
    this.touch(towerSessionId, session);
    await session.driverSession.cancelTurn(active.id);
  }

  /** Cancel a superseded turn and report whether its DriverSession is reusable. */
  async abandonTurn(towerSessionId: string, timeoutMs = 10_000): Promise<boolean> {
    const pendingOpen = this.opening.get(towerSessionId);
    if (pendingOpen) await pendingOpen.catch(() => undefined);
    const session = this.sessions.get(towerSessionId);
    const active = session?.activeTurn;
    if (!session || !active) return true;
    active.terminal = true;
    this.invalidatePermissions(towerSessionId, session, active.id);
    session.activeTurn = undefined;
    session.turnState = 'IDLE';
    this.touch(towerSessionId, session);

    const cancellation = (async () => {
      try {
        await session.driverSession.cancelTurn(active.id);
        await active.completion.catch(() => undefined);
        return true;
      } catch {
        return false;
      }
    })();
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        cancellation,
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async resolvePermission(towerSessionId: string, requestId: string, optionId: string): Promise<void> {
    const session = this.sessions.get(towerSessionId);
    const active = session?.activeTurn;
    const request = session?.pendingPermissions.get(requestId);
    if (!session || !active || !request || request.turnId !== active.id) {
      throw new AgentRuntimeError('permission_not_found', 'permission', 'Permission request is no longer active', false);
    }
    if (!request.options.some((option) => option.optionId === optionId)) {
      throw new AgentRuntimeError('permission_option_invalid', 'permission', 'Permission option was not offered', false);
    }
    if (!session.driverSession.resolvePermission) {
      throw new AgentRuntimeError('permission_not_supported', 'permission', 'Runtime cannot resolve permissions', false);
    }
    await session.driverSession.resolvePermission(requestId, optionId);
    session.pendingPermissions.delete(requestId);
    if (session.pendingPermissions.size === 0 && session.activeTurn?.id === active.id) {
      session.turnState = 'RUNNING';
    }
    this.touch(towerSessionId, session);
  }

  getState(towerSessionId: string, fallbackRuntimeType: RuntimeType = RuntimeType.CLI): RuntimeStateDto {
    const session = this.sessions.get(towerSessionId);
    if (!session) {
      return {
        sessionId: towerSessionId,
        runtimeType: fallbackRuntimeType,
        turnState: 'IDLE',
        capabilities: emptyCapabilities(),
        pendingPermissions: [],
      };
    }
    return this.toState(towerSessionId, session);
  }

  hasActiveTurn(towerSessionId: string): boolean {
    return this.sessions.get(towerSessionId)?.activeTurn !== undefined;
  }

  isAwaitingPermission(towerSessionId: string): boolean {
    return this.sessions.get(towerSessionId)?.turnState === 'AWAITING_PERMISSION';
  }

  writeInput(towerSessionId: string, data: string): void {
    this.sessions.get(towerSessionId)?.driverSession.writeInput?.(data);
  }

  resize(towerSessionId: string, cols: number, rows: number): void {
    this.sessions.get(towerSessionId)?.driverSession.resize?.(cols, rows);
  }

  async disposeSession(towerSessionId: string): Promise<void> {
    const pendingOpen = this.opening.get(towerSessionId);
    if (pendingOpen) await pendingOpen.catch(() => undefined);
    const session = this.sessions.get(towerSessionId);
    if (!session) return;
    this.sessions.delete(towerSessionId);
    this.invalidatePermissions(towerSessionId, session);
    session.activeTurn = undefined;
    session.turnState = 'DISPOSED';
    this.host.onRuntimeState(this.toState(towerSessionId, session));
    this.host.onDriverSessionDisposed?.(towerSessionId);
    await session.driverSession.close();
  }

  async destroyAll(): Promise<void> {
    if (this.destroying) return;
    this.destroying = true;
    const ids = new Set([...this.sessions.keys(), ...this.opening.keys()]);
    await Promise.allSettled([...ids].map((id) => this.disposeSession(id)));
    this.sessions.clear();
    this.opening.clear();
  }

  private async getOrOpen(input: StartRuntimeTurnInput): Promise<ManagedRuntimeSession> {
    const current = this.sessions.get(input.towerSessionId);
    if (current) {
      if (current.runtimeType !== input.runtimeType) {
        throw new AgentRuntimeError('runtime_type_mismatch', 'open', 'A session cannot switch runtime type', false);
      }
      return current;
    }
    const pending = this.opening.get(input.towerSessionId);
    if (pending) return pending;

    const opening = this.openSession(input);
    this.opening.set(input.towerSessionId, opening);
    try {
      return await opening;
    } finally {
      if (this.opening.get(input.towerSessionId) === opening) {
        this.opening.delete(input.towerSessionId);
      }
    }
  }

  private async openSession(input: StartRuntimeTurnInput): Promise<ManagedRuntimeSession> {
    const driver = this.registry.get(input.runtimeType);
    const openingSink = this.createOpeningSink(input.towerSessionId);
    const driverSession = await driver.open({
      towerSessionId: input.towerSessionId,
      agentType: input.agentType,
      runtimeType: input.runtimeType,
      variant: input.variant,
      providerId: input.providerId,
      workingDir: input.workingDir,
      env: input.env,
      externalSessionId: input.externalSessionId,
    }, openingSink);
    const session: ManagedRuntimeSession = {
      runtimeType: input.runtimeType,
      driverSession,
      turnState: 'IDLE',
      pendingPermissions: new Map(),
      lastActivityAt: new Date().toISOString(),
    };
    this.sessions.set(input.towerSessionId, session);
    this.host.onRuntimeState(this.toState(input.towerSessionId, session));
    return session;
  }

  private createOpeningSink(towerSessionId: string): RuntimeDriverEventSink {
    return {
      stream: () => undefined,
      process: async (event) => {
        await this.host.onProcessEvent({ ...event, towerSessionId } as RuntimeProcessEvent);
      },
    };
  }

  private createSink(
    towerSessionId: string,
    session: ManagedRuntimeSession,
    active: ActiveTurn,
  ): RuntimeDriverEventSink {
    return {
      stream: (event) => {
        if (!this.isCurrentTurn(session, active) || active.terminal) return;
        if (event.type === 'permission_requested') {
          if (event.request.sessionId !== towerSessionId || event.request.turnId !== active.id) return;
          session.pendingPermissions.set(event.request.requestId, event.request);
          session.turnState = 'AWAITING_PERMISSION';
        } else if (event.type === 'permission_invalidated') {
          session.pendingPermissions.delete(event.requestId);
          if (session.pendingPermissions.size === 0) session.turnState = 'RUNNING';
        }
        this.emitStream(towerSessionId, session, active, event);
      },
      process: async (event) => {
        await this.host.onProcessEvent({ ...event, towerSessionId } as RuntimeProcessEvent);
      },
    };
  }

  private emitStream(
    towerSessionId: string,
    session: ManagedRuntimeSession,
    active: ActiveTurn,
    event: RuntimeStreamEvent,
  ): void {
    active.sequence += 1;
    const envelope: RuntimeTurnEventEnvelope = {
      towerSessionId,
      turnId: active.id,
      sequence: active.sequence,
      timestamp: new Date().toISOString(),
      event,
    };
    this.host.onTurnEvent(envelope);
    this.touch(towerSessionId, session);
  }

  private emitTerminal(
    towerSessionId: string,
    session: ManagedRuntimeSession,
    active: ActiveTurn,
    event: Extract<RuntimeTurnEventEnvelope['event'], { type: 'completed' | 'failed' }>,
  ): void {
    if (!this.isCurrentTurn(session, active) || active.terminal) return;
    active.terminal = true;
    active.sequence += 1;
    this.host.onTurnEvent({
      towerSessionId,
      turnId: active.id,
      sequence: active.sequence,
      timestamp: new Date().toISOString(),
      event,
    });
    this.invalidatePermissions(towerSessionId, session, active.id);
    session.activeTurn = undefined;
    session.turnState = 'IDLE';
    this.touch(towerSessionId, session);
  }

  private invalidatePermissions(
    towerSessionId: string,
    session: ManagedRuntimeSession,
    turnId?: string,
  ): void {
    for (const [requestId, request] of [...session.pendingPermissions]) {
      if (turnId && request.turnId !== turnId) continue;
      session.pendingPermissions.delete(requestId);
      const active = session.activeTurn;
      if (active && active.id === request.turnId && !active.terminal) {
        this.emitStream(towerSessionId, session, active, { type: 'permission_invalidated', requestId });
      }
    }
  }

  private touch(towerSessionId: string, session: ManagedRuntimeSession): void {
    session.lastActivityAt = new Date().toISOString();
    this.host.onRuntimeState(this.toState(towerSessionId, session));
  }

  private toState(towerSessionId: string, session: ManagedRuntimeSession): RuntimeStateDto {
    return {
      sessionId: towerSessionId,
      runtimeType: session.runtimeType,
      turnState: session.turnState,
      ...(session.activeTurn ? { turnId: session.activeTurn.id } : {}),
      capabilities: session.driverSession.capabilities,
      pendingPermissions: [...session.pendingPermissions.values()],
      externalSessionId: session.driverSession.externalSessionId ?? null,
      lastActivityAt: session.lastActivityAt,
      ...(session.error ? { error: session.error } : {}),
    };
  }

  private isCurrentTurn(session: ManagedRuntimeSession, active: ActiveTurn): boolean {
    return session.activeTurn === active;
  }
}

function emptyCapabilities() {
  return {
    loadSession: false,
    terminalInput: false,
    terminalResize: false,
    permissions: false,
  };
}
