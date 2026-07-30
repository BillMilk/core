import { prisma } from '../utils/index.js';
import type { Prisma } from '@prisma/client';
import { AgentType, SessionStatus, SessionPurpose, TaskStatus, SessionContext } from '../types/index.js';
import {
  getProviderById,
  ExecutionEnv,
  normalizeExecutorStartError,
} from '../executors/index.js';
import { filterAgentSubprocessExternalEnv } from '../executors/execution-env.js';
import {
  sessionMsgStoreManager,
  createUserMessage,
  addNormalizedEntry,
} from '../output/index.js';
import type { NormalizedConversation } from '../output/index.js';
import { execGit } from '../git/git-cli.js';
import type { EventBus } from '../core/event-bus.js';
import { getCommitMessageService } from '../core/container.js';
import { TeamReconcilerService } from './team-reconciler.service.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { ensureTaskNotDeleted } from './deleted-task-guard.js';
import {
  getWorkspaceWorkingDir,
  isMainDirectoryWorkspace,
} from './workspace-kind.js';
import { writeErrorLog } from '../utils/error-log.js';
import { INTERNAL_API_TOKEN_ENV, readInternalApiTokenFromEnv } from '../utils/internal-api-token.js';
import { createHash } from 'node:crypto';
import { RuntimeType, supportsAgentRuntime, type RuntimeStateDto } from '@agent-tower/shared';
import { getProviderRuntimeType } from '../executors/providers.js';
import {
  CliRuntimeDriver,
  AcpRuntimeDriver,
  RuntimeCoordinator,
  StaticRuntimeRegistry,
  setRuntimeStateSnapshot,
  type RuntimeProcessEvent,
  type RuntimeTurnEventEnvelope,
} from '../runtime/index.js';

const DEBUG_SNAPSHOT = process.env.DEBUG_SNAPSHOT === 'true';

function hashForLog(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function summarizeTextForLog(value: string): { length: number; sha256: string } {
  return {
    length: Buffer.byteLength(value, 'utf8'),
    sha256: hashForLog(value),
  };
}

/**
 * 判断一个 session:patch 是否代表 agent 侧真实进展。
 *
 * SessionManager.sendMessage()（包括 TeamRun 心跳唤醒）会在本地写入一条 user_message entry 并 emit
 * session:patch。这类本地用户消息绝不能算作成员心跳，否则唤醒会刷新 lastHeartbeatAt 并在下一轮
 * watchdog 扫描中清零计数，使“连续 N 次 + 指数退避”失效。这里过滤掉“仅由 user_message 写入组成”的 patch；
 * 任何其它 op（agent entry 写入/替换、流式 content/metadata 更新等）都视为真实进展。
 */
function isAgentProgressPatch(patch: unknown): boolean {
  if (!Array.isArray(patch) || patch.length === 0) {
    return false;
  }
  return patch.some((op) => {
    const value = (op as { value?: unknown } | null)?.value;
    if (!value || typeof value !== 'object') {
      // 非整条 entry 写入（如对 /entries/N/content 的流式更新）视为 agent 进展。
      return true;
    }
    return (value as { entryType?: string }).entryType !== 'user_message';
  });
}

interface StopSessionOptions {
  skipTeamRunReconcile?: boolean;
}

type SessionExecutionRecord = Prisma.SessionGetPayload<{
  include: {
    workspace: { include: { task: true } };
    conversation: true;
  };
}>;

export class SessionManager {
  private snapshotFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private snapshotFlushChains = new Map<string, Promise<void>>();
  private sessionPersistenceWriterChain: Promise<void> = Promise.resolve();
  private dirtySnapshots = new Set<string>();
  private persistedSnapshotHashes = new Map<string, string>();
  private pendingSnapshotStatus = new Map<string, SessionStatus>();
  /** Terminal state gate: turn.completed and PTY exit may race each other. */
  private terminalSessions = new Map<string, SessionStatus>();
  private sessionFinalizations = new Map<string, Promise<void>>();
  /** Logical completion reserves this gate before broadcasting so a follow-up cannot overlap auto-commit. */
  private pendingAutoCommits = new Map<string, Promise<void>>();
  private pendingAutoCommitResolvers = new Map<string, () => void>();
  /**
   * A follow-up reserves the session before any async validation. Finalizers
   * wait on this reservation before reconciliation so a valid follow-up can
   * invalidate the old generation without racing Task/TeamRun post-processing.
   */
  private followUpReservations = new Map<string, Promise<void>>();
  private followUpReservationReleases = new Set<() => void>();
  /** Incremented for every start/send cycle so late post-processing cannot affect a new turn. */
  private sessionGenerations = new Map<string, number>();
  // 每个 session 上次写入 TeamRun 心跳时间戳的时刻，用于节流 lastHeartbeatAt 落库。
  private heartbeatThrottle = new Map<string, number>();
  private readonly teamReconciler: TeamReconcilerService;
  private readonly runtimeCoordinator: RuntimeCoordinator;
  private readonly runtimeProcessIds = new Map<string, string>();
  private readonly runtimePermissionStates = new Map<string, boolean>();
  private readonly externalSessionPersistence = new Map<string, Promise<void>>();
  private static readonly SNAPSHOT_CHECKPOINT_MS = 15_000;
  private static readonly HEARTBEAT_THROTTLE_MS = 30_000;

  constructor(private readonly eventBus: EventBus, teamReconciler?: TeamReconcilerService) {
    this.teamReconciler = teamReconciler ?? new TeamReconcilerService({
      eventBus,
      sessionMessenger: this,
      // 续催/唤醒统一由 MemberHeartbeatScheduler 轮询驱动；这里关闭内部 setTimeout 避免双驱动重复触发。
      // session 退出时的首次 reconcile（COMPLETED 判定 / 首次补催）仍即时执行，不依赖该定时器。
      scheduleReminders: false,
    });
    this.runtimeCoordinator = new RuntimeCoordinator(
      new StaticRuntimeRegistry([
        new CliRuntimeDriver(),
        new AcpRuntimeDriver(),
      ]),
      {
        onTurnEvent: (event) => this.handleRuntimeTurnEvent(event),
        onRuntimeState: (state) => this.handleRuntimeState(state),
        onProcessEvent: (event) => this.handleRuntimeProcessEvent(event),
      },
    );

    // Patches only mark the snapshot dirty. A low-frequency checkpoint keeps the
    // hot stream away from SQLite while terminal paths still force a final flush.
    this.eventBus.on('session:patch', ({ sessionId, patch }) => {
      if (DEBUG_SNAPSHOT) {
        const ops = (patch as Array<{ op?: string; path?: string }>).slice(0, 3)
          .map((p) => `${p.op ?? '?'}:${p.path ?? '?'}`)
          .join(', ');
        console.log(
          `[SessionManager:snapshot] patch sessionId=${sessionId} ops=${(patch as unknown[]).length} [${ops}]`
        );
      }
      this.scheduleSnapshotPersist(sessionId);
      // 仅 agent 侧真实进展用作 TeamRun 成员心跳信号（节流落库）；本地 user_message（含唤醒）被过滤。
      this.maybeRecordTeamRunHeartbeat(sessionId, patch);
    });

    this.eventBus.on('session:turn-completed', ({ sessionId }) => {
      if (this.terminalSessions.has(sessionId)) return;
      // The parser has already written raw stdout, the final assistant entry,
      // usage and all other state from the turn.completed chunk at this point.
      this.terminalSessions.set(sessionId, SessionStatus.COMPLETED);
      this.startSessionFinalization(sessionId, 0, { logicalCompletion: true });
    });

    this.eventBus.on('session:turn-failed', ({ sessionId }) => {
      if (this.terminalSessions.has(sessionId)) return;
      // A turn failure is terminal even when the CLI wrapper later exits 0 or
      // without an exit code. Use a synthetic non-zero code for the shared
      // finalization path so success-only post-processing cannot run.
      this.terminalSessions.set(sessionId, SessionStatus.FAILED);
      this.startSessionFinalization(sessionId, 1, { logicalCompletion: true });
    });

    // NOTE: checkTaskAutoRevert is called directly (awaited) inside start()
    // and sendMessage() to guarantee the task status is updated before the
    // HTTP response is sent. A fire-and-forget EventBus listener here caused
    // a race: the frontend refetch would see stale TODO status because the
    // DB update hadn't completed yet.
  }

  async findById(id: string) {
    return prisma.session.findUnique({
      where: { id },
      include: { processes: true, workspace: true, conversation: true },
    });
  }

  getRuntimeState(sessionId: string, runtimeType: RuntimeType = RuntimeType.CLI): RuntimeStateDto {
    return this.runtimeCoordinator.getState(sessionId, runtimeType);
  }

  async resolveRuntimePermission(sessionId: string, requestId: string, optionId: string): Promise<void> {
    await this.runtimeCoordinator.resolvePermission(sessionId, requestId, optionId);
  }

  async create(workspaceId: string, agentType: AgentType, prompt: string, variant: string = 'DEFAULT', providerId?: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { task: true },
    });
    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }
    ensureTaskNotDeleted(workspace.task);

    const provider = providerId ? getProviderById(providerId) : null;
    if (providerId && !provider) {
      throw new ValidationError(`Provider not found: ${providerId}`);
    }
    if (provider && provider.agentType !== agentType) {
      throw new ValidationError(
        `Provider '${provider.name}' belongs to agent '${provider.agentType}', not '${agentType}'`,
      );
    }
    const runtimeType = provider ? getProviderRuntimeType(provider) : RuntimeType.CLI;
    if (!supportsAgentRuntime(agentType, runtimeType)) {
      throw new ValidationError(`Agent '${agentType}' does not support the '${runtimeType}' runtime`);
    }

    return prisma.session.create({
      data: {
        workspaceId,
        context: SessionContext.WORKSPACE,
        agentType,
        runtimeType,
        variant,
        providerId: providerId ?? null,
        prompt,
        status: SessionStatus.PENDING,
      },
    });
  }

  async start(id: string) {
    console.log('[SessionManager] 🚀 Starting session:', id);

    const session = await this.findSessionExecutionRecord(id);
    if (!session) {
      console.log('[SessionManager] ❌ Session not found:', id);
      return null;
    }
    await this.waitForPendingAutoCommit(id);
    this.beginSessionExecution(id);
    this.ensureExecutionRecordIsLive(session);
    const workingDir = this.getExecutionWorkingDir(session);

    console.log('[SessionManager] Session details:', {
      id: session.id,
      agentType: session.agentType,
      variant: session.variant,
      prompt: summarizeTextForLog(session.prompt),
      workingDir,
    });

    await this.startRuntimeTurn(session, session.prompt, session.externalSessionId);
    return session;
  }

  async startFollowUp(id: string, resumeFromSessionId: string) {
    console.log('[SessionManager] 🚀 Starting follow-up session:', id);
    console.log('[SessionManager] Resume from Tower session:', resumeFromSessionId);

    const session = await this.findSessionExecutionRecord(id);
    if (!session) {
      console.log('[SessionManager] ❌ Session not found:', id);
      return null;
    }
    await this.waitForPendingAutoCommit(id);
    this.beginSessionExecution(id);
    this.ensureExecutionRecordIsLive(session);

    const resumeFromSession = await prisma.session.findUnique({
      where: { id: resumeFromSessionId },
      select: { logSnapshot: true, externalSessionId: true },
    });
    const agentSessionId = resumeFromSession
      ? resumeFromSession.externalSessionId
        ?? this.resolveAgentSessionId(resumeFromSessionId, resumeFromSession.logSnapshot)
      : null;

    console.log('[SessionManager] Follow-up session details:', {
      id: session.id,
      resumeFromSessionId,
      agentSessionId,
      agentType: session.agentType,
      variant: session.variant,
      prompt: summarizeTextForLog(session.prompt),
      workingDir: this.getExecutionWorkingDir(session),
    });

    await this.startRuntimeTurn(session, session.prompt, agentSessionId);
    return session;
  }

  async sendMessage(id: string, message: string, providerId?: string) {
    console.log('[SessionManager] 📨 Sending message to session:', id);
    console.log('[SessionManager] Message summary:', summarizeTextForLog(message));
    if (providerId) {
      console.log('[SessionManager] Switching provider to:', providerId);
    }

    const reservation = this.reserveFollowUp(id);
    try {
      // Serialize concurrent follow-ups for the same session while retaining
      // the reservation in the map so the old finalizer cannot reconcile.
      await reservation.previous;

      const session = await this.findSessionExecutionRecord(id);
      if (!session) {
        console.log('[SessionManager] ❌ Session not found:', id);
        return null;
      }
      this.ensureExecutionRecordIsLive(session);

      // Always validate the effective provider, including when it is inherited
      // from the session or explicitly repeats the current provider. A stale
      // session provider must not invalidate the completed generation.
      const effectiveProviderId = providerId ?? session.providerId;
      if (effectiveProviderId) {
        const effectiveProvider = getProviderById(effectiveProviderId);
        if (!effectiveProvider) {
          throw new Error(`Provider not found: ${effectiveProviderId}`);
        }
        if (String(effectiveProvider.agentType) !== session.agentType) {
          throw new Error(
            `Cannot switch provider: agentType mismatch. Session uses '${session.agentType}', but provider '${effectiveProvider.name}' is for '${effectiveProvider.agentType}'`
          );
        }
        if (getProviderRuntimeType(effectiveProvider) !== this.normalizeRuntimeType(session.runtimeType)) {
          throw new Error(
            `Cannot switch provider: runtimeType mismatch. Session uses '${session.runtimeType}', but provider '${effectiveProvider.name}' uses '${getProviderRuntimeType(effectiveProvider)}'`
          );
        }
      }

      if (providerId && providerId !== session.providerId) {
        const switchedProvider = getProviderById(providerId);
        await prisma.session.update({
          where: { id },
          data: { providerId },
        });
        console.log(`[SessionManager] ✅ Provider switched to: ${switchedProvider?.name ?? providerId}`);
      }

      // A rejected follow-up must not cancel the completed turn's post-exit
      // work. Advance the generation only after the session/provider checks and
      // any provider persistence have succeeded, immediately before replacing
      // the old execution with the new one.
      this.invalidateSessionGeneration(id);
      this.beginSessionExecution(id);

    // Stop the previous turn before waiting for its auto-commit boundary. The
    // coordinator suppresses that superseded turn's terminal event so it cannot
    // finalize the newly reserved generation.
    if (this.runtimeCoordinator.hasActiveTurn(id)) {
      if (DEBUG_SNAPSHOT) {
        console.log(`[SessionManager:snapshot] sendMessage checkpoint before runtime turn replace sessionId=${id}`);
      }
      await this.flushSnapshotPersist(id);
      const canReuseDriverSession = await this.runtimeCoordinator.abandonTurn(id);
      if (!canReuseDriverSession) {
        await this.runtimeCoordinator.disposeSession(id);
      }
    }
    await this.waitForPendingAutoCommit(id);

    const isNewStore = !sessionMsgStoreManager.has(id);
    const msgStore = sessionMsgStoreManager.getOrCreate(id);

    if (isNewStore && session.logSnapshot) {
      try {
        const snapshot = JSON.parse(session.logSnapshot) as NormalizedConversation;
        msgStore.restoreFromSnapshot(snapshot);
      } catch (error) {
        console.error(`[SessionManager] Failed to restore snapshot for session ${id}:`, error);
      }
    }

    // Heal index drift caused by previously failed patches (e.g. invalid value).
    // If entryIndex is ahead of snapshot length, subsequent add/replace paths
    // become out-of-bounds and all later patches fail.
    const preflightSnapshot = msgStore.getSnapshot();
    const expectedIndex = preflightSnapshot.entries.length;
    const currentIndex = msgStore.entryIndex.current();
    if (currentIndex !== expectedIndex) {
      if (DEBUG_SNAPSHOT) {
        console.warn(
          `[SessionManager:snapshot] rebase entryIndex sessionId=${id} currentIndex=${currentIndex} expectedIndex=${expectedIndex}`
        );
      }
      msgStore.entryIndex.startFrom(expectedIndex);
    }

    const userEntry = createUserMessage(message);
    const userIndex = msgStore.entryIndex.next();
    const userPatch = addNormalizedEntry(userIndex, userEntry);
    if (DEBUG_SNAPSHOT) {
      console.log(
        `[SessionManager:snapshot] sendMessage userPatch sessionId=${id} index=${userIndex} currentIndex=${msgStore.entryIndex.current()}`
      );
    }
    const userPatchSeq = msgStore.pushPatch(userPatch);
    // Emit directly to EventBus — the old pipeline was already destroyed so
    // MsgStore's patchListeners are empty at this point. Without this line
    // the user-message patch would never reach WebSocket subscribers.
    this.eventBus.emit('session:patch', { sessionId: id, patch: userPatch, seq: userPatchSeq });

      const agentSessionId = session.externalSessionId
        ?? this.resolveAgentSessionId(id, session.logSnapshot);
      if (providerId && providerId !== session.providerId) {
        await this.runtimeCoordinator.disposeSession(id);
      }
      await this.startRuntimeTurn(session, message, agentSessionId, effectiveProviderId);
      return session;
    } finally {
      reservation.release();
    }
  }

  async stop(id: string, options: StopSessionOptions = {}) {
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return null;

    const terminalStatus = this.terminalSessions.get(id);
    const hasActiveTurn = this.runtimeCoordinator.hasActiveTurn(id);
    const persistedTerminal = [
      SessionStatus.COMPLETED,
      SessionStatus.FAILED,
      SessionStatus.CANCELLED,
    ].includes(session.status as SessionStatus);
    if (!hasActiveTurn && (terminalStatus || persistedTerminal)) {
      const pendingFinalization = this.sessionFinalizations.get(id);
      // A terminal transition already won the race. A late user stop may
      // clean up the PTY, but it must not regress the persisted status. The
      // backing TeamRun invocation may still be waiting for a room reply, so
      // it must still pass through the cancellation reconciler.
      await this.runtimeCoordinator.disposeSession(id);
      this.maybeClearTerminalState(id);
      await pendingFinalization;
      if (!options.skipTeamRunReconcile && !this.isConversationSession(session)) {
        await this.teamReconciler.handleSessionStopped(id);
      }
      return session;
    }
    this.terminalSessions.set(id, SessionStatus.CANCELLED);

    const runtimeType = this.normalizeRuntimeType(session.runtimeType);
    if (runtimeType === RuntimeType.ACP && hasActiveTurn) {
      const canReuseDriverSession = await this.runtimeCoordinator.abandonTurn(id).catch((error) => {
        this.logSessionError('session.runtimeCancel', error, { sessionId: id });
        return false;
      });
      if (!canReuseDriverSession) {
        await this.runtimeCoordinator.disposeSession(id).catch((error) => {
          this.logSessionError('session.runtimeDispose', error, { sessionId: id });
        });
      }
    } else {
      await this.runtimeCoordinator.cancelTurn(id).catch((error) => {
        this.logSessionError('session.runtimeCancel', error, { sessionId: id });
      });
      await this.runtimeCoordinator.disposeSession(id).catch((error) => {
        this.logSessionError('session.runtimeDispose', error, { sessionId: id });
      });
    }

    const msgStore = sessionMsgStoreManager.get(id);
    if (msgStore) {
      msgStore.pushFinished();
      try {
        await this.flushSnapshotPersist(id, SessionStatus.CANCELLED);
      } catch (error) {
        console.error(`[SessionManager] Failed to persist cancelled snapshot for ${id}:`, error);
        await prisma.session.update({
          where: { id },
          data: { status: SessionStatus.CANCELLED },
        });
      }
    } else {
      await prisma.session.update({
        where: { id },
        data: { status: SessionStatus.CANCELLED },
      });
    }

    if (!options.skipTeamRunReconcile && !this.isConversationSession(session)) {
      await this.teamReconciler.handleSessionStopped(id);
    }
    this.eventBus.emit('session:stopped', { sessionId: id });
    // Cancellation does not run normal terminal finalization, so release the
    // store after the CANCELLED snapshot has been persisted above.
    sessionMsgStoreManager.delete(id);
    this.releaseSnapshotPersistenceState(id);
    return session;
  }

  /** @deprecated Use hasActiveTurn(). */
  hasActivePipeline(sessionId: string): boolean {
    return this.runtimeCoordinator.hasActiveTurn(sessionId);
  }

  hasActiveTurn(sessionId: string): boolean {
    return this.runtimeCoordinator.hasActiveTurn(sessionId);
  }

  isAwaitingPermission(sessionId: string): boolean {
    return this.runtimeCoordinator.isAwaitingPermission(sessionId);
  }

  /**
   * 节流写入 TeamRun invocation 的心跳时间戳。非 TeamRun session 无对应 invocation，updateMany 命中 0 行无副作用。
   */
  private maybeRecordTeamRunHeartbeat(sessionId: string, patch: unknown): void {
    // 过滤掉本地 user_message patch（含心跳唤醒注入的消息），只让 agent 真实进展刷新心跳。
    if (!isAgentProgressPatch(patch)) {
      return;
    }
    const now = Date.now();
    const last = this.heartbeatThrottle.get(sessionId) ?? 0;
    if (now - last < SessionManager.HEARTBEAT_THROTTLE_MS) {
      return;
    }
    this.heartbeatThrottle.set(sessionId, now);
    this.teamReconciler.recordHeartbeat(sessionId).catch((error) => {
      console.warn(
        `[SessionManager] Failed to record TeamRun heartbeat for ${sessionId}:`,
        error instanceof Error ? error.message : error
      );
    });
  }

  writeInput(sessionId: string, data: string): void {
    this.runtimeCoordinator.writeInput(sessionId, data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.runtimeCoordinator.resize(sessionId, cols, rows);
  }

  /** Close all runtime driver sessions during graceful server shutdown. */
  async destroyAll(): Promise<void> {
    await this.runtimeCoordinator.destroyAll();
    await Promise.allSettled(this.externalSessionPersistence.values());
    this.externalSessionPersistence.clear();
    this.terminalSessions.clear();
    for (const resolve of this.pendingAutoCommitResolvers.values()) resolve();
    this.pendingAutoCommitResolvers.clear();
    this.pendingAutoCommits.clear();
    for (const release of [...this.followUpReservationReleases]) release();
    this.followUpReservationReleases.clear();
    this.followUpReservations.clear();
  }

  private resolveAgentSessionId(sessionId: string, logSnapshot: string | null): string | null {
    const msgStore = sessionMsgStoreManager.get(sessionId);
    if (msgStore) {
      const snapshot = msgStore.getSnapshot();
      if (snapshot.sessionId) return snapshot.sessionId;
    }

    if (logSnapshot) {
      try {
        const parsed = JSON.parse(logSnapshot) as NormalizedConversation;
        if (parsed.sessionId) return parsed.sessionId;
      } catch {
        // ignore invalid snapshot json
      }
    }
    return null;
  }

  private async startRuntimeTurn(
    session: SessionExecutionRecord,
    prompt: string,
    resumeExternalSessionId?: string | null,
    providerId: string | null = session.providerId,
  ): Promise<void> {
    const workingDir = this.getExecutionWorkingDir(session);
    const env = ExecutionEnv.default(workingDir);
    if (providerId) {
      const provider = getProviderById(providerId);
      if (provider && Object.keys(provider.env).length > 0) {
        env.merge(filterAgentSubprocessExternalEnv(provider.env));
      }
    }
    this.injectAgentTowerMcpServiceEnv(env);
    if (!this.isConversationSession(session)) {
      await this.injectTeamRunInvocationEnv(session.id, env);
    }

    const isNewStore = !sessionMsgStoreManager.has(session.id);
    const msgStore = sessionMsgStoreManager.getOrCreate(session.id);
    if (isNewStore && session.logSnapshot) {
      try {
        msgStore.restoreFromSnapshot(JSON.parse(session.logSnapshot) as NormalizedConversation);
      } catch (error) {
        this.logSessionError('session.snapshotRestore', error, { sessionId: session.id });
      }
    }

    try {
      // Session status follows the logical Runtime turn, not the lifetime of
      // its backing OS process. ACP reuses one adapter process across turns,
      // so a follow-up must become RUNNING even when no process starts.
      await prisma.session.update({
        where: { id: session.id },
        data: { status: SessionStatus.RUNNING },
      });
      const handle = await this.runtimeCoordinator.startTurn({
        towerSessionId: session.id,
        agentType: session.agentType as AgentType,
        runtimeType: this.normalizeRuntimeType(session.runtimeType),
        variant: session.variant ?? 'DEFAULT',
        providerId,
        workingDir,
        env,
        externalSessionId: session.externalSessionId,
        msgStore,
        prompt,
        resumeExternalSessionId,
      });
      // Terminal persistence is driven by Runtime turn events. Attach a catch
      // so the public start/message methods do not leave a rejected handle
      // unobserved after they have returned to the HTTP caller.
      void handle.completion.catch(() => undefined);
      this.eventBus.emit('session:started', { sessionId: session.id });
      await this.checkTaskAutoRevert(session.id);
    } catch (error) {
      await this.runtimeCoordinator.disposeSession(session.id).catch(() => undefined);
      await prisma.session.update({
        where: { id: session.id },
        data: { status: SessionStatus.CANCELLED },
      }).catch(() => undefined);
      sessionMsgStoreManager.delete(session.id);
      this.releaseSnapshotPersistenceState(session.id);
      this.logSessionError('session.runtimeStart', error, {
        sessionId: session.id,
        agentType: session.agentType,
        runtimeType: session.runtimeType,
        providerId,
        workingDir,
      });
      throw normalizeExecutorStartError(error);
    }
  }

  private handleRuntimeTurnEvent(envelope: RuntimeTurnEventEnvelope): void {
    const sessionId = envelope.towerSessionId;
    const event = envelope.event;
    if (event.type === 'stdout') {
      this.eventBus.emit('session:stdout', { sessionId, data: event.data });
      return;
    }
    if (event.type === 'conversation_patch') {
      this.eventBus.emit('session:patch', { sessionId, patch: event.patch, seq: event.seq });
      return;
    }
    if (event.type === 'external_session_id') {
      const previous = this.externalSessionPersistence.get(sessionId) ?? Promise.resolve();
      const persistence = previous
        .then(() => this.enqueueSessionPersistenceWrite(async () => {
          await prisma.session.update({
            where: { id: sessionId },
            data: { externalSessionId: event.externalSessionId },
          });
        }))
        .then(() => undefined)
        .catch((error) => {
          this.logSessionError('session.externalSessionId', error, { sessionId });
        });
      this.externalSessionPersistence.set(sessionId, persistence);
      void persistence.finally(() => {
        if (this.externalSessionPersistence.get(sessionId) === persistence) {
          this.externalSessionPersistence.delete(sessionId);
        }
      });
      this.eventBus.emit('session:sessionId', {
        sessionId,
        agentSessionId: event.externalSessionId,
      });
      return;
    }
    if (event.type === 'permission_requested') {
      this.eventBus.emit('session:permission_requested', {
        sessionId,
        permission: event.request,
      });
      return;
    }
    if (event.type === 'permission_invalidated') {
      this.eventBus.emit('session:permission_invalidated', {
        sessionId,
        turnId: envelope.turnId,
        requestId: event.requestId,
      });
      return;
    }
    if (event.type === 'completed') {
      this.eventBus.emit('session:turn-completed', { sessionId });
      this.eventBus.emit('session:exit', { sessionId, exitCode: 0 });
      return;
    }
    if (event.type === 'failed') {
      this.eventBus.emit('session:turn-failed', { sessionId });
      this.eventBus.emit('session:exit', { sessionId, exitCode: 1 });
    }
  }

  private handleRuntimeState(state: RuntimeStateDto): void {
    setRuntimeStateSnapshot(state);
    this.eventBus.emit('session:runtime_state_changed', {
      sessionId: state.sessionId,
      state,
    });
    const awaitingPermission = state.turnState === 'AWAITING_PERMISSION';
    const previous = this.runtimePermissionStates.get(state.sessionId) ?? false;
    if (state.turnState === 'DISPOSED') {
      this.runtimePermissionStates.delete(state.sessionId);
    } else {
      this.runtimePermissionStates.set(state.sessionId, awaitingPermission);
    }
    if (previous !== awaitingPermission) {
      void this.invalidateTeamRunRuntimeState(state.sessionId);
    }
  }

  private async invalidateTeamRunRuntimeState(sessionId: string): Promise<void> {
    const invocation = await prisma.agentInvocation.findFirst({
      where: { sessionId },
      select: {
        teamRunId: true,
        teamRun: { select: { taskId: true, task: { select: { projectId: true } } } },
      },
    });
    if (!invocation) return;
    this.eventBus.emit('team-run:invalidated', {
      teamRunId: invocation.teamRunId,
      taskId: invocation.teamRun.taskId,
      projectId: invocation.teamRun.task.projectId,
      scopes: ['team-members', 'agent-invocations', 'team-run'],
      reason: 'agent-invocation-updated',
    });
  }

  private async handleRuntimeProcessEvent(event: RuntimeProcessEvent): Promise<void> {
    if (event.type === 'started') {
      const processRecord = await prisma.$transaction(async (tx) => {
        const session = await tx.session.findUnique({
          where: { id: event.towerSessionId },
          include: { workspace: { include: { task: true } }, conversation: true },
        });
        if (!session) throw new NotFoundError('Session', event.towerSessionId);
        this.ensureExecutionRecordIsLive(session);
        return tx.executionProcess.create({
          data: { sessionId: event.towerSessionId, pid: event.pid },
          select: { id: true },
        });
      });
      this.runtimeProcessIds.set(event.runtimeInstanceId, processRecord.id);
      return;
    }

    const processId = this.runtimeProcessIds.get(event.runtimeInstanceId);
    if (!processId) return;
    this.runtimeProcessIds.delete(event.runtimeInstanceId);
    await prisma.executionProcess.update({
      where: { id: processId },
      data: { exitCode: event.exitCode },
    }).catch((error) => {
      this.logSessionError('session.processExit', error, {
        sessionId: event.towerSessionId,
        processId,
        exitCode: event.exitCode,
      });
    });
  }

  private normalizeRuntimeType(value: unknown): RuntimeType {
    return value === RuntimeType.ACP ? RuntimeType.ACP : RuntimeType.CLI;
  }

  private injectAgentTowerMcpServiceEnv(env: ExecutionEnv): void {
    const serviceEnv: Record<string, string> = {};
    if (process.env.AGENT_TOWER_URL) {
      serviceEnv.AGENT_TOWER_URL = process.env.AGENT_TOWER_URL;
    }
    if (process.env.AGENT_TOWER_PORT) {
      serviceEnv.AGENT_TOWER_PORT = process.env.AGENT_TOWER_PORT;
    }
    const internalToken = readInternalApiTokenFromEnv();
    if (internalToken) {
      serviceEnv[INTERNAL_API_TOKEN_ENV] = internalToken;
    }
    if (Object.keys(serviceEnv).length > 0) {
      env.merge(serviceEnv);
    }
  }

  private async injectTeamRunInvocationEnv(sessionId: string, env: ExecutionEnv): Promise<void> {
    const invocation = await prisma.agentInvocation.findFirst({
      where: { sessionId },
      select: {
        id: true,
        teamRunId: true,
        memberId: true,
        targetPort: true,
        targetVitePort: true,
        targetE2EPort: true,
      },
    });

    if (!invocation) {
      return;
    }

    env.merge({
      AGENT_TOWER_SESSION_ID: sessionId,
      AGENT_TOWER_INVOCATION_ID: invocation.id,
      AGENT_TOWER_TEAM_RUN_ID: invocation.teamRunId,
      AGENT_TOWER_MEMBER_ID: invocation.memberId,
    });

    const portEnv: Record<string, string> = {};
    if (invocation.targetPort != null) {
      portEnv.PORT = String(invocation.targetPort);
    }
    if (invocation.targetVitePort != null) {
      portEnv.VITE_PORT = String(invocation.targetVitePort);
    }
    if (invocation.targetE2EPort != null) {
      portEnv.E2E_PORT = String(invocation.targetE2EPort);
    }
    if (Object.keys(portEnv).length > 0) {
      env.merge(portEnv);
    }
  }

  /**
   * Agent 进程退出后自动提交未保存的变更。
   * 保证 worktree 始终干净的兜底机制，最终会被 squash merge 合并。
   * 参考: vibe-kanban crates/local-deployment/src/container.rs:496-505
   */
  private async autoCommitChanges(sessionId: string, generation?: number): Promise<void> {
    try {
      if (!this.isCurrentGeneration(sessionId, generation)) return;
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { workspace: true },
      });
      if (!this.isCurrentGeneration(sessionId, generation)) return;
      if (!session?.workspace || isMainDirectoryWorkspace(session.workspace)) return;
      if (!session.workspace.worktreePath) return;

      const worktreePath = session.workspace.worktreePath;

      const status = await execGit(worktreePath, ['status', '--porcelain']);
      if (!this.isCurrentGeneration(sessionId, generation)) return;
      if (!status.trim()) return;

      await execGit(worktreePath, ['add', '-A']);
      if (!this.isCurrentGeneration(sessionId, generation)) return;
      await execGit(worktreePath, [
        'commit', '-m',
        `auto-commit: uncommitted changes from session ${sessionId.slice(0, 8)}`,
      ]);
      if (!this.isCurrentGeneration(sessionId, generation)) return;

      console.log(`[SessionManager] Auto-committed changes for session ${sessionId}`);
    } catch (error) {
      // auto-commit 失败不应阻断后续流程
      console.warn(
        `[SessionManager] Auto-commit failed for session ${sessionId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  private scheduleSnapshotPersist(sessionId: string, status?: SessionStatus): void {
    this.dirtySnapshots.add(sessionId);
    if (status) {
      this.pendingSnapshotStatus.set(sessionId, status);
    }
    if (this.snapshotFlushTimers.has(sessionId)) {
      return;
    }

    const nextTimer = setTimeout(() => {
      this.snapshotFlushTimers.delete(sessionId);
      if (DEBUG_SNAPSHOT) {
        console.log(`[SessionManager:snapshot] checkpoint fire sessionId=${sessionId}`);
      }
      this.flushSnapshotPersist(sessionId).catch((error) => {
        console.error(`[SessionManager] Snapshot checkpoint failed for ${sessionId}:`, error);
        if ((error as { code?: string } | null)?.code === 'P2025') {
          this.releaseSnapshotPersistenceState(sessionId);
          return;
        }
        if (sessionMsgStoreManager.has(sessionId)) {
          this.scheduleSnapshotPersist(sessionId);
        }
      });
    }, SessionManager.SNAPSHOT_CHECKPOINT_MS);
    this.snapshotFlushTimers.set(sessionId, nextTimer);
    if (DEBUG_SNAPSHOT) {
      console.log(
        `[SessionManager:snapshot] checkpoint scheduled sessionId=${sessionId} ms=${SessionManager.SNAPSHOT_CHECKPOINT_MS} status=${status ?? 'none'}`
      );
    }
  }

  private async flushSnapshotPersist(sessionId: string, status?: SessionStatus): Promise<void> {
    if (status) {
      this.pendingSnapshotStatus.set(sessionId, status);
    }
    const timer = this.snapshotFlushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.snapshotFlushTimers.delete(sessionId);
    }

    const previous = this.snapshotFlushChains.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // Keep the chain alive even if previous flush failed.
      })
      .then(() => this.enqueueSessionPersistenceWrite(() => this.persistSnapshot(sessionId)));

    this.snapshotFlushChains.set(sessionId, current);
    try {
      await current;
    } finally {
      if (this.snapshotFlushChains.get(sessionId) === current) {
        this.snapshotFlushChains.delete(sessionId);
      }
    }
  }

  private async enqueueSessionPersistenceWrite(write: () => Promise<void>): Promise<void> {
    const queued = this.sessionPersistenceWriterChain
      .catch(() => {
        // Keep the global writer alive after an isolated persistence failure.
      })
      .then(write);
    this.sessionPersistenceWriterChain = queued;

    try {
      await queued;
    } finally {
      if (this.sessionPersistenceWriterChain === queued) {
        this.sessionPersistenceWriterChain = Promise.resolve();
      }
    }
  }

  private async persistSnapshot(sessionId: string): Promise<void> {
    const pendingStatus = this.pendingSnapshotStatus.get(sessionId);
    const wasDirty = this.dirtySnapshots.delete(sessionId);
    this.pendingSnapshotStatus.delete(sessionId);

    if (!pendingStatus && !wasDirty) {
      return;
    }

    try {
      if (DEBUG_SNAPSHOT) {
        console.log(
          `[SessionManager:snapshot] flush start sessionId=${sessionId} pendingStatus=${pendingStatus ?? 'none'} dirty=${wasDirty}`
        );
      }

      const msgStore = sessionMsgStoreManager.get(sessionId);
      if (!msgStore) {
        if (pendingStatus) {
          await prisma.session.update({
            where: { id: sessionId },
            data: { status: pendingStatus },
          });
        }
        return;
      }

      const snapshot = msgStore.getSnapshot();
      const serializedSnapshot = JSON.stringify(snapshot);
      const snapshotHash = createHash('sha256').update(serializedSnapshot).digest('hex');
      const snapshotChanged = this.persistedSnapshotHashes.get(sessionId) !== snapshotHash;
      const tokenUsage = snapshotChanged ? this.extractTokenUsageFromSnapshot(snapshot) : null;

      if (!snapshotChanged && !pendingStatus) {
        return;
      }

      await prisma.session.update({
        where: { id: sessionId },
        data: {
          ...(pendingStatus ? { status: pendingStatus } : {}),
          ...(snapshotChanged ? {
            logSnapshot: serializedSnapshot,
            ...(tokenUsage ? { tokenUsage: JSON.stringify(tokenUsage) } : {}),
          } : {}),
        },
      });

      if (snapshotChanged) {
        this.persistedSnapshotHashes.set(sessionId, snapshotHash);
      }
      if (DEBUG_SNAPSHOT) {
        console.log(
          `[SessionManager:snapshot] flush persisted sessionId=${sessionId} status=${pendingStatus ?? 'unchanged'} entries=${snapshot.entries.length} changed=${snapshotChanged}`
        );
      }
    } catch (error) {
      if (wasDirty) {
        this.dirtySnapshots.add(sessionId);
      }
      if (pendingStatus && !this.pendingSnapshotStatus.has(sessionId)) {
        this.pendingSnapshotStatus.set(sessionId, pendingStatus);
      }
      throw error;
    }
  }

  private releaseSnapshotPersistenceState(sessionId: string): void {
    const timer = this.snapshotFlushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.snapshotFlushTimers.delete(sessionId);
    }
    this.dirtySnapshots.delete(sessionId);
    this.pendingSnapshotStatus.delete(sessionId);
    this.persistedSnapshotHashes.delete(sessionId);
  }

  private extractTokenUsageFromSnapshot(snapshot: NormalizedConversation): { totalTokens: number; modelContextWindow?: number } | null {
    for (let i = snapshot.entries.length - 1; i >= 0; i--) {
      const entry = snapshot.entries[i];
      if (entry.entryType === 'token_usage_info' && entry.metadata?.tokenUsage?.totalTokens != null) {
        return entry.metadata.tokenUsage as { totalTokens: number; modelContextWindow?: number };
      }
    }
    return null;
  }

  private async findSessionExecutionRecord(sessionId: string) {
    return prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        workspace: { include: { task: true } },
        conversation: true,
      },
    });
  }

  private isConversationSession(session: { context?: string | null; conversationId?: string | null }): boolean {
    return session.context === SessionContext.CONVERSATION || Boolean(session.conversationId);
  }

  private ensureExecutionRecordIsLive(session: SessionExecutionRecord): void {
    if (this.isConversationSession(session)) {
      if (!session.conversation || session.conversation.deletedAt) {
        throw new NotFoundError('Conversation', session.conversationId ?? session.id);
      }
      return;
    }

    if (!session.workspace) {
      throw new NotFoundError('Workspace', session.workspaceId ?? session.id);
    }
    ensureTaskNotDeleted(session.workspace.task);
  }

  private getExecutionWorkingDir(session: SessionExecutionRecord): string {
    if (this.isConversationSession(session)) {
      if (!session.conversation) {
        throw new NotFoundError('Conversation', session.conversationId ?? session.id);
      }
      return session.conversation.workingDir;
    }

    if (!session.workspace) {
      throw new NotFoundError('Workspace', session.workspaceId ?? session.id);
    }
    return getWorkspaceWorkingDir(session.workspace);
  }

  /**
   * Session 完成后检查 Task 是否可以自动推进状态。
   *
   * 规则：当一个 Task 下所有 Workspace 的所有 CHAT Session 都处于终态
   * （COMPLETED / CANCELLED / FAILED）时，自动将 IN_PROGRESS 的 Task
   * 推进到 IN_REVIEW，提示用户进行代码审查。
   * 同时触发 commit message 的后台生成。
   */
  private async checkTaskAutoAdvance(sessionId: string): Promise<void> {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { workspace: { include: { task: true } } },
      });
      if (!session?.workspace?.task) return;

      const task = session.workspace.task;
      if (task.deletedAt) return;
      // 只对 IN_PROGRESS 的 Task 做自动推进
      if (task.status !== TaskStatus.IN_PROGRESS) return;

      // 查询该 Task 下所有 CHAT Session（排除 COMMIT_MSG）
      const allSessions = await prisma.session.findMany({
        where: {
          workspace: { taskId: task.id },
          purpose: { not: SessionPurpose.COMMIT_MSG },
        },
        select: { status: true },
      });

      const terminalStatuses: string[] = [SessionStatus.COMPLETED, SessionStatus.CANCELLED, SessionStatus.FAILED];
      const allDone = allSessions.every((s) => terminalStatuses.includes(s.status));

      if (allDone && allSessions.length > 0) {
        await prisma.task.update({
          where: { id: task.id },
          data: { status: TaskStatus.IN_REVIEW },
        });

        this.eventBus.emit('task:updated', {
          taskId: task.id,
          projectId: task.projectId,
          status: TaskStatus.IN_REVIEW,
        });

        console.log(`[SessionManager] Task ${task.id} auto-advanced to IN_REVIEW (all sessions completed)`);
      }
    } catch (error) {
      console.error(`[SessionManager] checkTaskAutoAdvance failed for session ${sessionId}:`, error);
    }
  }

  /**
   * 异步触发 commit message 生成（fire-and-forget）
   */
  private triggerCommitMessageGeneration(workspaceId: string): void {
    const commitMessageService = getCommitMessageService();
    commitMessageService.triggerGeneration(workspaceId).catch((error) => {
      console.warn(
        `[SessionManager] Failed to trigger commit message generation for workspace ${workspaceId}:`,
        error instanceof Error ? error.message : error
      );
    });
  }

  /**
   * Session 启动时自动更新 Task 状态。
   *
   * 规则：
   * 1. TODO → IN_PROGRESS：首次启动 session 时，任务开始进行
   * 2. IN_REVIEW/DONE → IN_PROGRESS：重新启动 session 时，任务回退到进行中
   * 注意：COMMIT_MSG session 启动不应触发状态变更。
   */
  private async checkTaskAutoRevert(sessionId: string): Promise<void> {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { workspace: { include: { task: true } } },
      });
      if (!session?.workspace?.task) return;

      // COMMIT_MSG session 不触发状态变更
      if (session.purpose === SessionPurpose.COMMIT_MSG) return;

      const task = session.workspace.task;
      if (task.deletedAt) return;

      // 如果任务已经是 IN_PROGRESS，无需更新
      if (task.status === TaskStatus.IN_PROGRESS) return;

      // TODO、IN_REVIEW、DONE 都应该转为 IN_PROGRESS
      const shouldUpdate = [TaskStatus.TODO, TaskStatus.IN_REVIEW, TaskStatus.DONE].includes(task.status as TaskStatus);
      if (!shouldUpdate) return;

      await prisma.task.update({
        where: { id: task.id },
        data: { status: TaskStatus.IN_PROGRESS },
      });

      this.eventBus.emit('task:updated', {
        taskId: task.id,
        projectId: task.projectId,
        status: TaskStatus.IN_PROGRESS,
      });

      console.log(
        `[SessionManager] Task ${task.id} status updated from ${task.status} to IN_PROGRESS (session ${sessionId} started)`,
      );
    } catch (error) {
      console.error(`[SessionManager] checkTaskAutoRevert failed for session ${sessionId}:`, error);
    }
  }

  /**
   * Session 退出后的统一处理入口。
   * 根据 session purpose 走不同的后处理路径。
   * exitCode 非 0 时标记为 FAILED。
   */
  private async handleSessionExit(
    sessionId: string,
    exitCode?: number,
    options: { logicalCompletion?: boolean; generation?: number } = {},
  ): Promise<void> {
    const generation = options.generation ?? this.sessionGenerations.get(sessionId);
    await this.externalSessionPersistence.get(sessionId);
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { purpose: true, context: true, conversationId: true },
    });

    // exitCode 非 0 且非 undefined 视为失败
    const isFailed = typeof exitCode === 'number' && exitCode !== 0;
    const finalStatus = isFailed ? SessionStatus.FAILED : SessionStatus.COMPLETED;

    // Persist and broadcast logical completion before any auto-commit or
    // provider cleanup work. This is the user-visible fast path; the later
    // PTY cleanup and post-exit work remain best-effort background work.
    if (options.logicalCompletion) {
      await this.flushSnapshotPersist(sessionId, finalStatus);
      if (!this.isCurrentGeneration(sessionId, generation)) {
        this.releaseAutoCommitGate(sessionId);
        return;
      }
      this.eventBus.emit('session:completed', { sessionId, status: finalStatus });
    }

    if (isFailed) {
      console.warn(`[SessionManager] Session ${sessionId} exited with code ${exitCode}, marking as FAILED`);
      writeErrorLog({
        level: 'warn',
        source: 'session.exit',
        message: `Session exited with non-zero code ${exitCode}`,
        metadata: { sessionId, exitCode },
      });
    }

    if (session?.context === SessionContext.CONVERSATION || session?.conversationId) {
      this.releaseAutoCommitGate(sessionId);
      if (!options.logicalCompletion) {
        await this.flushSnapshotPersist(sessionId, finalStatus);
      }
      if (session.conversationId) {
        await prisma.conversation.update({
          where: { id: session.conversationId },
          data: { lastActiveAt: new Date() },
        }).catch(() => {
          // Conversation may have been deleted while the process exited.
        });
      }
      if (!options.logicalCompletion) {
        this.eventBus.emit('session:completed', { sessionId, status: finalStatus });
      }
    } else if (session?.purpose === SessionPurpose.COMMIT_MSG) {
      // COMMIT_MSG session: 只需持久化快照，然后提取 commit message
      this.releaseAutoCommitGate(sessionId);
      if (!options.logicalCompletion) {
        await this.flushSnapshotPersist(sessionId, finalStatus);
      }
      if (!isFailed) {
        try {
          const commitMessageService = getCommitMessageService();
          await commitMessageService.extractAndCache(sessionId);
        } catch (error) {
          console.warn(
            `[SessionManager] Failed to extract commit message from session ${sessionId}:`,
            error instanceof Error ? error.message : error
          );
        }
      }
      // 通知前端 session 状态（DB 状态已更新）
      if (!options.logicalCompletion) {
        this.eventBus.emit('session:completed', { sessionId, status: finalStatus });
      }
    } else {
      // 正常 CHAT session: autoCommit → 持久化 → 检查 Task 推进 → 触发 commit message 生成
      if (!isFailed && this.isCurrentGeneration(sessionId, generation)) {
        try {
          await this.autoCommitChanges(sessionId, generation);
        } finally {
          // Follow-up requests wait for this boundary before advancing the
          // generation, so no Git operation can overlap the new turn.
          this.releaseAutoCommitGate(sessionId);
        }
      } else {
        this.releaseAutoCommitGate(sessionId);
      }
      // A follow-up may still be validating its session/provider. Keep the
      // old generation inside this boundary until the follow-up either fails
      // (and releases the reservation) or advances the generation and enters
      // its new execution.
      await this.waitForFollowUpReservation(sessionId);
      if (!this.isCurrentGeneration(sessionId, generation)) return;
      if (!options.logicalCompletion) {
        await this.flushSnapshotPersist(sessionId, finalStatus);
      }
      // 通知前端 session 状态（DB 状态已更新）
      if (!options.logicalCompletion) {
        this.eventBus.emit('session:completed', { sessionId, status: finalStatus });
      }

      if (!this.isCurrentGeneration(sessionId, generation)) return;

      const handledByTeamRun = await this.teamReconciler.handleSessionExit(sessionId);
      if (!this.isCurrentGeneration(sessionId, generation)) return;

      if (!isFailed) {
        if (!handledByTeamRun) {
          await this.checkTaskAutoAdvance(sessionId);
        }
        if (!this.isCurrentGeneration(sessionId, generation)) return;

        // 每次 CHAT session 完成都触发 commit message 重新生成
        const sess = await prisma.session.findUnique({
          where: { id: sessionId },
          select: { workspaceId: true },
        });
        if (sess?.workspaceId) {
          this.triggerCommitMessageGeneration(sess.workspaceId);
        }
      }
    }

    // 释放内存中的 MsgStore，防止单例 Map 随会话数量无限增长（每个最高 100MB）。
    // 此时快照已通过 flushSnapshotPersist 持久化到 DB；后续读取（/logs API、
    // sendMessage 重启、resolveAgentSessionId、commit message 提取）都有
    // logSnapshot fallback，sendMessage 会经 restoreFromSnapshot 恢复上下文。
    if (this.isCurrentGeneration(sessionId, generation)) {
      sessionMsgStoreManager.delete(sessionId);
      this.releaseSnapshotPersistenceState(sessionId);
    }
  }

  private beginSessionExecution(sessionId: string): void {
    this.clearTerminalState(sessionId);
    this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1);
  }

  private invalidateSessionGeneration(sessionId: string): void {
    this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1);
  }

  private clearTerminalState(sessionId: string): void {
    this.terminalSessions.delete(sessionId);
  }

  private startSessionFinalization(
    sessionId: string,
    exitCode?: number,
    options: { logicalCompletion?: boolean } = {},
  ): void {
    if (options.logicalCompletion) {
      this.reserveAutoCommitGate(sessionId);
    }
    const source = options.logicalCompletion ? 'session.logicalCompletion' : 'session.postExit';
    const generation = this.sessionGenerations.get(sessionId);
    const finalization = this.handleSessionExit(sessionId, exitCode, { ...options, generation })
      .catch((error) => {
        this.releaseAutoCommitGate(sessionId);
        console.error(`[SessionManager] ${source} handling failed for ${sessionId}:`, error);
        writeErrorLog({
          level: 'error',
          source,
          message: `Session finalization failed for session ${sessionId}`,
          error,
          metadata: { sessionId, exitCode },
        });
      })
      .finally(() => {
        if (this.sessionFinalizations.get(sessionId) === finalization) {
          this.sessionFinalizations.delete(sessionId);
        }
        this.maybeClearTerminalState(sessionId);
      });
    this.sessionFinalizations.set(sessionId, finalization);
  }

  private maybeClearTerminalState(sessionId: string): void {
    if (this.sessionFinalizations.has(sessionId)) return;
    this.terminalSessions.delete(sessionId);
  }

  private isCurrentGeneration(sessionId: string, generation?: number): boolean {
    return generation === undefined || this.sessionGenerations.get(sessionId) === generation;
  }

  private reserveAutoCommitGate(sessionId: string): void {
    if (this.pendingAutoCommits.has(sessionId)) return;
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    this.pendingAutoCommits.set(sessionId, gate);
    this.pendingAutoCommitResolvers.set(sessionId, resolveGate);
  }

  private releaseAutoCommitGate(sessionId: string): void {
    const resolveGate = this.pendingAutoCommitResolvers.get(sessionId);
    if (resolveGate) resolveGate();
    this.pendingAutoCommitResolvers.delete(sessionId);
    this.pendingAutoCommits.delete(sessionId);
  }

  private async waitForPendingAutoCommit(sessionId: string): Promise<void> {
    await this.pendingAutoCommits.get(sessionId);
  }

  private reserveFollowUp(sessionId: string): {
    previous: Promise<void>;
    release: () => void;
  } {
    const previous = this.followUpReservations.get(sessionId) ?? Promise.resolve();
    let resolveReservation!: () => void;
    const reservation = new Promise<void>((resolve) => {
      resolveReservation = resolve;
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      resolveReservation();
      this.followUpReservationReleases.delete(release);
      if (this.followUpReservations.get(sessionId) === reservation) {
        this.followUpReservations.delete(sessionId);
      }
    };
    this.followUpReservations.set(sessionId, reservation);
    this.followUpReservationReleases.add(release);
    return { previous, release };
  }

  private async waitForFollowUpReservation(sessionId: string): Promise<void> {
    // Follow-ups can queue behind one another. Re-check after each reservation
    // resolves so a finalizer never observes only an earlier queue item.
    while (true) {
      const reservation = this.followUpReservations.get(sessionId);
      if (!reservation) return;
      await reservation;
      if (this.followUpReservations.get(sessionId) === reservation) return;
    }
  }

  private logSessionError(source: string, error: unknown, metadata: Record<string, unknown>): void {
    writeErrorLog({
      level: 'error',
      source,
      message: error instanceof Error ? error.message : String(error),
      error,
      metadata,
    });
  }
}
