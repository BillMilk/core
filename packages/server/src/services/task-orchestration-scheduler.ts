import { TaskOrchestrationService } from './task-orchestration.service.js';

const DEFAULT_TICK_INTERVAL_MS = 30_000;
const DEFAULT_STALE_AFTER_MS = 10 * 60_000;

export interface TaskOrchestrationSchedulerDependencies {
  service?: Pick<TaskOrchestrationService, 'recoverStaleClaims'>;
  tickIntervalMs?: number;
  staleAfterMs?: number;
}

/**
 * Small local recovery loop for orchestration leases.
 *
 * Dispatch remains explicit through TaskOrchestrationService.claim/claimNext;
 * this loop only handles the crash/orphan half of the lifecycle so a server
 * restart cannot leave a worker-owned task permanently stuck.
 */
export class TaskOrchestrationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly service: Pick<TaskOrchestrationService, 'recoverStaleClaims'>;
  private readonly tickIntervalMs: number;
  private readonly staleAfterMs: number;

  constructor(dependencies: TaskOrchestrationSchedulerDependencies = {}) {
    this.service = dependencies.service ?? new TaskOrchestrationService();
    this.tickIntervalMs = dependencies.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.staleAfterMs = dependencies.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.service.recoverStaleClaims(this.staleAfterMs);
    } catch (error) {
      console.warn(
        '[TaskOrchestrationScheduler] Recovery tick failed:',
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.running = false;
    }
  }
}
