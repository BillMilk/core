import type { Prisma } from '@prisma/client';
import {
  TaskOrchestrationStatus,
  TaskStatus,
  type TaskDependency as SharedTaskDependency,
  type TaskDependencyResponse,
  type TaskEvent as SharedTaskEvent,
  type TaskEventType,
  type TaskReadinessResponse,
} from '@agent-tower/shared';
import type { EventBus } from '../core/event-bus.js';
import {
  InvalidStateTransitionError,
  NotFoundError,
  ServiceError,
  ValidationError,
} from '../errors.js';
import { prisma } from '../utils/index.js';

const READY_OR_RECOVERING_STATUSES = [
  TaskOrchestrationStatus.READY,
  TaskOrchestrationStatus.RECOVERING,
] as const;

const DEPENDENCY_COMPLETE_OR = [
  { orchestrationStatus: TaskOrchestrationStatus.DONE },
  { status: TaskStatus.DONE },
] as const;

const VALID_TRANSITIONS: Record<TaskOrchestrationStatus, readonly TaskOrchestrationStatus[]> = {
  [TaskOrchestrationStatus.BACKLOG]: [
    TaskOrchestrationStatus.READY,
    TaskOrchestrationStatus.CANCELLED,
  ],
  [TaskOrchestrationStatus.READY]: [
    TaskOrchestrationStatus.ASSIGNED,
    TaskOrchestrationStatus.BLOCKED,
    TaskOrchestrationStatus.CANCELLED,
  ],
  [TaskOrchestrationStatus.ASSIGNED]: [
    TaskOrchestrationStatus.RUNNING,
    TaskOrchestrationStatus.READY,
    TaskOrchestrationStatus.HANDOFF,
    TaskOrchestrationStatus.RECOVERING,
    TaskOrchestrationStatus.CANCELLED,
  ],
  [TaskOrchestrationStatus.RUNNING]: [
    TaskOrchestrationStatus.REVIEW,
    TaskOrchestrationStatus.BLOCKED,
    TaskOrchestrationStatus.HANDOFF,
    TaskOrchestrationStatus.RECOVERING,
    TaskOrchestrationStatus.CANCELLED,
  ],
  [TaskOrchestrationStatus.REVIEW]: [
    TaskOrchestrationStatus.RUNNING,
    TaskOrchestrationStatus.MERGING,
    TaskOrchestrationStatus.DONE,
    TaskOrchestrationStatus.MERGE_FAILED,
    TaskOrchestrationStatus.CANCELLED,
  ],
  [TaskOrchestrationStatus.MERGING]: [
    TaskOrchestrationStatus.DONE,
    TaskOrchestrationStatus.MERGE_FAILED,
    TaskOrchestrationStatus.RECOVERING,
  ],
  [TaskOrchestrationStatus.DONE]: [
    TaskOrchestrationStatus.REVIEW,
    TaskOrchestrationStatus.CANCELLED,
  ],
  [TaskOrchestrationStatus.BLOCKED]: [
    TaskOrchestrationStatus.READY,
    TaskOrchestrationStatus.HANDOFF,
    TaskOrchestrationStatus.CANCELLED,
  ],
  [TaskOrchestrationStatus.HANDOFF]: [
    TaskOrchestrationStatus.READY,
    TaskOrchestrationStatus.ASSIGNED,
    TaskOrchestrationStatus.CANCELLED,
  ],
  [TaskOrchestrationStatus.RECOVERING]: [
    TaskOrchestrationStatus.READY,
    TaskOrchestrationStatus.ASSIGNED,
    TaskOrchestrationStatus.HANDOFF,
    TaskOrchestrationStatus.CANCELLED,
  ],
  [TaskOrchestrationStatus.MERGE_FAILED]: [
    TaskOrchestrationStatus.REVIEW,
    TaskOrchestrationStatus.HANDOFF,
    TaskOrchestrationStatus.RECOVERING,
    TaskOrchestrationStatus.CANCELLED,
  ],
  [TaskOrchestrationStatus.CANCELLED]: [
    TaskOrchestrationStatus.BACKLOG,
    TaskOrchestrationStatus.READY,
  ],
};

export interface TaskOrchestrationServiceDependencies {
  now?: () => Date;
}

export interface TaskOrchestrationTransitionOptions {
  workerId?: string;
  actorType?: string;
  actorId?: string;
  reason?: string;
}

export interface TaskOrchestrationTask {
  id: string;
  projectId: string;
  title: string;
  status: string;
  orchestrationStatus: TaskOrchestrationStatus;
  orchestrationClaimedBy: string | null;
  orchestrationClaimedAt: Date | null;
  orchestrationHeartbeatAt: Date | null;
  orchestrationAttemptCount: number;
  orchestrationLastError: string | null;
}

export interface RecoverStaleClaimsResult {
  recovered: number;
  taskIds: string[];
}

type TaskSummaryRow = {
  id: string;
  projectId: string;
  title: string;
  status: string;
  orchestrationStatus: string;
};

type TaskDependencyRow = {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  createdAt: Date;
  task?: TaskSummaryRow;
  dependsOnTask?: TaskSummaryRow;
};

type TaskEventRow = {
  id: string;
  taskId: string;
  projectId: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorType: string;
  actorId: string | null;
  payload: string | null;
  createdAt: Date;
};

function parsePayload(payload: string | null): unknown {
  if (!payload) return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

function serializeTaskSummary(task: TaskSummaryRow | undefined) {
  if (!task) return undefined;
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status as TaskStatus,
    orchestrationStatus: task.orchestrationStatus as TaskOrchestrationStatus,
  };
}

function serializeDependency(row: TaskDependencyRow): SharedTaskDependency {
  return {
    id: row.id,
    taskId: row.taskId,
    dependsOnTaskId: row.dependsOnTaskId,
    createdAt: row.createdAt.toISOString(),
    ...(row.task ? { task: serializeTaskSummary(row.task) } : {}),
    ...(row.dependsOnTask ? { dependsOnTask: serializeTaskSummary(row.dependsOnTask) } : {}),
  };
}

function serializeEvent(row: TaskEventRow): SharedTaskEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    type: row.type as TaskEventType,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    actorType: row.actorType,
    actorId: row.actorId,
    payload: parsePayload(row.payload),
    createdAt: row.createdAt.toISOString(),
  };
}

function orchestrationEventType(toStatus: TaskOrchestrationStatus): TaskEventType {
  switch (toStatus) {
    case TaskOrchestrationStatus.RUNNING:
      return 'task.started';
    case TaskOrchestrationStatus.DONE:
      return 'task.completed';
    case TaskOrchestrationStatus.MERGE_FAILED:
    case TaskOrchestrationStatus.BLOCKED:
      return 'task.failed';
    case TaskOrchestrationStatus.READY:
    case TaskOrchestrationStatus.HANDOFF:
      return 'task.released';
    default:
      return 'task.status_changed';
  }
}

function toTaskOrchestrationTask(task: {
  id: string;
  projectId: string;
  title: string;
  status: string;
  orchestrationStatus: string;
  orchestrationClaimedBy: string | null;
  orchestrationClaimedAt: Date | null;
  orchestrationHeartbeatAt: Date | null;
  orchestrationAttemptCount: number;
  orchestrationLastError: string | null;
}): TaskOrchestrationTask {
  return {
    ...task,
    orchestrationStatus: task.orchestrationStatus as TaskOrchestrationStatus,
  };
}

async function createTaskEvent(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    projectId: string;
    type: TaskEventType;
    fromStatus?: string | null;
    toStatus?: string | null;
    actorType?: string;
    actorId?: string;
    payload?: unknown;
    idempotencyKey?: string;
  },
): Promise<void> {
  await tx.taskEvent.create({
    data: {
      taskId: input.taskId,
      projectId: input.projectId,
      type: input.type,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      actorType: input.actorType ?? 'SYSTEM',
      actorId: input.actorId ?? null,
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });
}

/** Append one durable event outside a larger orchestration transaction. */
export async function appendTaskEvent(input: {
  taskId: string;
  projectId: string;
  type: TaskEventType;
  fromStatus?: string | null;
  toStatus?: string | null;
  actorType?: string;
  actorId?: string;
  payload?: unknown;
  idempotencyKey?: string;
}): Promise<void> {
  await prisma.$transaction((tx) => createTaskEvent(tx, input));
}

export class TaskOrchestrationService {
  private readonly now: () => Date;

  constructor(
    private readonly eventBus?: EventBus,
    dependencies: TaskOrchestrationServiceDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async addDependency(taskId: string, dependsOnTaskId: string): Promise<SharedTaskDependency> {
    if (taskId === dependsOnTaskId) {
      throw new ValidationError('A task cannot depend on itself');
    }

    const task = await prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { id: true, projectId: true },
    });
    if (!task) throw new NotFoundError('Task', taskId);

    const prerequisite = await prisma.task.findFirst({
      where: { id: dependsOnTaskId, deletedAt: null },
      select: { id: true, projectId: true },
    });
    if (!prerequisite) throw new NotFoundError('Task', dependsOnTaskId);
    if (task.projectId !== prerequisite.projectId) {
      throw new ValidationError('Task dependencies must stay within the same project');
    }

    return prisma.$transaction(async (tx) => {
      const existing = await tx.taskDependency.findUnique({
        where: { taskId_dependsOnTaskId: { taskId, dependsOnTaskId } },
        include: {
          dependsOnTask: {
            select: {
              id: true,
              projectId: true,
              title: true,
              status: true,
              orchestrationStatus: true,
            },
          },
        },
      });
      if (existing) {
        return serializeDependency(existing as TaskDependencyRow);
      }

      const projectTasks = await tx.task.findMany({
        where: { projectId: task.projectId, deletedAt: null },
        select: { id: true },
      });
      const taskIds = projectTasks.map((item) => item.id);
      const edges = await tx.taskDependency.findMany({
        where: { taskId: { in: taskIds } },
        select: { taskId: true, dependsOnTaskId: true },
      });
      const adjacency = new Map<string, string[]>();
      for (const edge of edges) {
        adjacency.set(edge.taskId, [
          ...(adjacency.get(edge.taskId) ?? []),
          edge.dependsOnTaskId,
        ]);
      }

      const visited = new Set<string>();
      const pending = [dependsOnTaskId];
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (current === taskId) {
          throw new ValidationError('Task dependency would create a cycle');
        }
        if (visited.has(current)) continue;
        visited.add(current);
        pending.push(...(adjacency.get(current) ?? []));
      }

      const created = await tx.taskDependency.create({
        data: { taskId, dependsOnTaskId },
        include: {
          dependsOnTask: {
            select: {
              id: true,
              projectId: true,
              title: true,
              status: true,
              orchestrationStatus: true,
            },
          },
        },
      });
      await createTaskEvent(tx, {
        taskId,
        projectId: task.projectId,
        type: 'task.dependency_added',
        payload: { dependsOnTaskId },
      });
      return serializeDependency(created as TaskDependencyRow);
    });
  }

  async removeDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    const task = await prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { id: true, projectId: true },
    });
    if (!task) throw new NotFoundError('Task', taskId);

    const dependency = await prisma.taskDependency.findUnique({
      where: { taskId_dependsOnTaskId: { taskId, dependsOnTaskId } },
    });
    if (!dependency) {
      throw new NotFoundError('TaskDependency', `${taskId}:${dependsOnTaskId}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.taskDependency.delete({ where: { id: dependency.id } });
      await createTaskEvent(tx, {
        taskId,
        projectId: task.projectId,
        type: 'task.dependency_removed',
        payload: { dependsOnTaskId },
      });
    });
  }

  async listDependencies(taskId: string): Promise<TaskDependencyResponse> {
    const task = await prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { id: true },
    });
    if (!task) throw new NotFoundError('Task', taskId);

    const [prerequisites, dependents] = await Promise.all([
      prisma.taskDependency.findMany({
        where: { taskId },
        orderBy: { createdAt: 'asc' },
        include: {
          dependsOnTask: {
            select: {
              id: true,
              projectId: true,
              title: true,
              status: true,
              orchestrationStatus: true,
            },
          },
        },
      }),
      prisma.taskDependency.findMany({
        where: { dependsOnTaskId: taskId },
        orderBy: { createdAt: 'asc' },
        include: {
          task: {
            select: {
              id: true,
              projectId: true,
              title: true,
              status: true,
              orchestrationStatus: true,
            },
          },
        },
      }),
    ]);

    return {
      taskId,
      prerequisites: prerequisites.map((row) => serializeDependency(row as TaskDependencyRow)),
      dependents: dependents.map((row) => serializeDependency(row as TaskDependencyRow)),
    };
  }

  async getReadiness(taskId: string): Promise<TaskReadinessResponse> {
    const task = await prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: {
        id: true,
        orchestrationStatus: true,
        dependencies: {
          orderBy: { createdAt: 'asc' },
          include: {
            dependsOnTask: {
              select: {
                id: true,
                projectId: true,
                title: true,
                status: true,
                orchestrationStatus: true,
              },
            },
          },
        },
      },
    });
    if (!task) throw new NotFoundError('Task', taskId);

    const blockers = task.dependencies
      .filter((dependency) => {
        const prerequisite = dependency.dependsOnTask;
        return prerequisite.orchestrationStatus !== TaskOrchestrationStatus.DONE
          && prerequisite.status !== TaskStatus.DONE;
      })
      .map((row) => serializeDependency(row as TaskDependencyRow));

    return {
      taskId,
      orchestrationStatus: task.orchestrationStatus as TaskOrchestrationStatus,
      ready: READY_OR_RECOVERING_STATUSES.includes(
        task.orchestrationStatus as (typeof READY_OR_RECOVERING_STATUSES)[number],
      ) && blockers.length === 0,
      blockers,
    };
  }

  async listReadyTasks(projectId?: string, limit = 50): Promise<TaskOrchestrationTask[]> {
    const safeLimit = Math.min(200, Math.max(1, limit));
    const tasks = await prisma.task.findMany({
      where: {
        ...(projectId ? { projectId } : {}),
        deletedAt: null,
        orchestrationStatus: { in: [...READY_OR_RECOVERING_STATUSES] },
        dependencies: {
          every: { dependsOnTask: { OR: [...DEPENDENCY_COMPLETE_OR] } },
        },
      },
      orderBy: [
        { priority: 'desc' },
        { position: 'asc' },
        { createdAt: 'asc' },
      ],
      take: safeLimit,
      select: {
        id: true,
        projectId: true,
        title: true,
        status: true,
        orchestrationStatus: true,
        orchestrationClaimedBy: true,
        orchestrationClaimedAt: true,
        orchestrationHeartbeatAt: true,
        orchestrationAttemptCount: true,
        orchestrationLastError: true,
      },
    });
    return tasks.map((task) => toTaskOrchestrationTask(task));
  }

  async markReady(taskId: string, options: TaskOrchestrationTransitionOptions = {}) {
    const readiness = await this.getReadiness(taskId);
    if (readiness.blockers.length > 0) {
      throw new ServiceError(
        'Task has incomplete dependencies',
        'TASK_BLOCKED',
        409,
      );
    }
    return this.transition(taskId, TaskOrchestrationStatus.READY, options);
  }

  async claimNext(workerId: string, projectId?: string): Promise<TaskOrchestrationTask | null> {
    const normalizedWorkerId = workerId.trim();
    if (!normalizedWorkerId) throw new ValidationError('workerId is required');

    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.task.findFirst({
        where: {
          ...(projectId ? { projectId } : {}),
          deletedAt: null,
          orchestrationClaimedBy: null,
          orchestrationStatus: { in: [...READY_OR_RECOVERING_STATUSES] },
          dependencies: {
            every: { dependsOnTask: { OR: [...DEPENDENCY_COMPLETE_OR] } },
          },
        },
        orderBy: [
          { priority: 'desc' },
          { position: 'asc' },
          { createdAt: 'asc' },
        ],
        select: {
          id: true,
          projectId: true,
          title: true,
          status: true,
          orchestrationStatus: true,
          orchestrationClaimedBy: true,
          orchestrationClaimedAt: true,
          orchestrationHeartbeatAt: true,
          orchestrationAttemptCount: true,
          orchestrationLastError: true,
        },
      });
      if (!task) return null;

      const now = this.now();
      const updated = await tx.task.updateMany({
        where: {
          id: task.id,
          orchestrationClaimedBy: null,
          orchestrationStatus: task.orchestrationStatus,
        },
        data: {
          orchestrationStatus: TaskOrchestrationStatus.ASSIGNED,
          orchestrationClaimedBy: normalizedWorkerId,
          orchestrationClaimedAt: now,
          orchestrationHeartbeatAt: now,
          orchestrationAttemptCount: { increment: 1 },
          orchestrationLastError: null,
        },
      });
      if (updated.count !== 1) return null;

      await createTaskEvent(tx, {
        taskId: task.id,
        projectId: task.projectId,
        type: 'task.claimed',
        fromStatus: task.orchestrationStatus,
        toStatus: TaskOrchestrationStatus.ASSIGNED,
        actorType: 'WORKER',
        actorId: normalizedWorkerId,
        payload: { workerId: normalizedWorkerId },
      });

      return {
        task: await tx.task.findUniqueOrThrow({
          where: { id: task.id },
          select: {
            id: true,
            projectId: true,
            title: true,
            status: true,
            orchestrationStatus: true,
            orchestrationClaimedBy: true,
            orchestrationClaimedAt: true,
            orchestrationHeartbeatAt: true,
            orchestrationAttemptCount: true,
            orchestrationLastError: true,
          },
        }),
        previousStatus: task.orchestrationStatus,
      };
    });

    if (result) {
      this.emitOrchestrationUpdated(
        result.task.id,
        result.task.projectId,
        result.task.orchestrationStatus,
        result.previousStatus,
      );
      return toTaskOrchestrationTask(result.task);
    }
    return null;
  }

  async claim(taskId: string, workerId: string): Promise<TaskOrchestrationTask> {
    const normalizedWorkerId = workerId.trim();
    if (!normalizedWorkerId) throw new ValidationError('workerId is required');

    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.task.findFirst({
        where: { id: taskId, deletedAt: null },
        select: {
          id: true,
          projectId: true,
          title: true,
          status: true,
          orchestrationStatus: true,
          orchestrationClaimedBy: true,
          orchestrationClaimedAt: true,
          orchestrationHeartbeatAt: true,
          orchestrationAttemptCount: true,
          orchestrationLastError: true,
          dependencies: {
            select: {
              dependsOnTask: {
                select: { status: true, orchestrationStatus: true },
              },
            },
          },
        },
      });
      if (!task) throw new NotFoundError('Task', taskId);
      if (!READY_OR_RECOVERING_STATUSES.includes(
        task.orchestrationStatus as (typeof READY_OR_RECOVERING_STATUSES)[number],
      )) {
        throw new InvalidStateTransitionError(
          task.orchestrationStatus,
          TaskOrchestrationStatus.ASSIGNED,
        );
      }

      const hasBlocker = task.dependencies.some((dependency) => {
        const prerequisite = dependency.dependsOnTask;
        return prerequisite.orchestrationStatus !== TaskOrchestrationStatus.DONE
          && prerequisite.status !== TaskStatus.DONE;
      });
      if (hasBlocker) {
        throw new ServiceError('Task has incomplete dependencies', 'TASK_BLOCKED', 409);
      }

      const now = this.now();
      const updated = await tx.task.updateMany({
        where: {
          id: taskId,
          deletedAt: null,
          orchestrationClaimedBy: null,
          orchestrationStatus: task.orchestrationStatus,
        },
        data: {
          orchestrationStatus: TaskOrchestrationStatus.ASSIGNED,
          orchestrationClaimedBy: normalizedWorkerId,
          orchestrationClaimedAt: now,
          orchestrationHeartbeatAt: now,
          orchestrationAttemptCount: { increment: 1 },
          orchestrationLastError: null,
        },
      });
      if (updated.count !== 1) {
        throw new ServiceError('Task was claimed by another worker', 'TASK_ALREADY_CLAIMED', 409);
      }

      await createTaskEvent(tx, {
        taskId,
        projectId: task.projectId,
        type: 'task.claimed',
        fromStatus: task.orchestrationStatus,
        toStatus: TaskOrchestrationStatus.ASSIGNED,
        actorType: 'WORKER',
        actorId: normalizedWorkerId,
        payload: { workerId: normalizedWorkerId },
      });

      return {
        task: await tx.task.findUniqueOrThrow({
          where: { id: taskId },
          select: {
            id: true,
            projectId: true,
            title: true,
            status: true,
            orchestrationStatus: true,
            orchestrationClaimedBy: true,
            orchestrationClaimedAt: true,
            orchestrationHeartbeatAt: true,
            orchestrationAttemptCount: true,
            orchestrationLastError: true,
          },
        }),
        previousStatus: task.orchestrationStatus,
      };
    });

    this.emitOrchestrationUpdated(
      result.task.id,
      result.task.projectId,
      result.task.orchestrationStatus,
      result.previousStatus,
    );
    return toTaskOrchestrationTask(result.task);
  }

  async transition(
    taskId: string,
    toStatus: TaskOrchestrationStatus,
    options: TaskOrchestrationTransitionOptions = {},
  ): Promise<TaskOrchestrationTask> {
    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.task.findFirst({
        where: { id: taskId, deletedAt: null },
        select: {
          id: true,
          projectId: true,
          title: true,
          status: true,
          orchestrationStatus: true,
          orchestrationClaimedBy: true,
          orchestrationClaimedAt: true,
          orchestrationHeartbeatAt: true,
          orchestrationAttemptCount: true,
          orchestrationLastError: true,
        },
      });
      if (!task) throw new NotFoundError('Task', taskId);

      const fromStatus = task.orchestrationStatus as TaskOrchestrationStatus;
      if (fromStatus === toStatus) {
        return { task, previousStatus: fromStatus, changed: false };
      }
      if (!VALID_TRANSITIONS[fromStatus]?.includes(toStatus)) {
        throw new InvalidStateTransitionError(fromStatus, toStatus);
      }
      if (options.workerId && task.orchestrationClaimedBy !== options.workerId) {
        throw new ServiceError('Task is owned by another worker', 'TASK_LEASE_MISMATCH', 409);
      }

      const now = this.now();
      const clearsLease = [
        TaskOrchestrationStatus.READY,
        TaskOrchestrationStatus.REVIEW,
        TaskOrchestrationStatus.DONE,
        TaskOrchestrationStatus.CANCELLED,
        TaskOrchestrationStatus.HANDOFF,
        TaskOrchestrationStatus.RECOVERING,
      ].includes(toStatus);
      const boardStatus = this.boardStatusFor(toStatus);
      const updated = await tx.task.update({
        where: { id: taskId },
        data: {
          orchestrationStatus: toStatus,
          ...(clearsLease
            ? {
                orchestrationClaimedBy: null,
                orchestrationClaimedAt: null,
                orchestrationHeartbeatAt: null,
              }
            : { orchestrationHeartbeatAt: now }),
          ...(toStatus === TaskOrchestrationStatus.BLOCKED || toStatus === TaskOrchestrationStatus.MERGE_FAILED
            ? { orchestrationLastError: options.reason ?? null }
            : toStatus === TaskOrchestrationStatus.READY
              ? { orchestrationLastError: null }
              : {}),
          ...(boardStatus ? { status: boardStatus } : {}),
        },
        select: {
          id: true,
          projectId: true,
          title: true,
          status: true,
          orchestrationStatus: true,
          orchestrationClaimedBy: true,
          orchestrationClaimedAt: true,
          orchestrationHeartbeatAt: true,
          orchestrationAttemptCount: true,
          orchestrationLastError: true,
        },
      });
      await createTaskEvent(tx, {
        taskId,
        projectId: task.projectId,
        type: orchestrationEventType(toStatus),
        fromStatus,
        toStatus,
        actorType: options.actorType ?? (options.workerId ? 'WORKER' : 'SYSTEM'),
        actorId: options.actorId ?? options.workerId,
        payload: options.reason ? { reason: options.reason } : undefined,
      });
      return { task: updated, previousStatus: fromStatus, changed: true };
    });

    if (result.changed) {
      this.emitOrchestrationUpdated(
        result.task.id,
        result.task.projectId,
        result.task.orchestrationStatus,
        result.previousStatus,
      );
    }
    return toTaskOrchestrationTask(result.task);
  }

  async heartbeat(taskId: string, workerId: string): Promise<TaskOrchestrationTask> {
    const now = this.now();
    const current = await prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: {
        id: true,
        projectId: true,
        title: true,
        status: true,
        orchestrationStatus: true,
        orchestrationClaimedBy: true,
        orchestrationClaimedAt: true,
        orchestrationHeartbeatAt: true,
        orchestrationAttemptCount: true,
        orchestrationLastError: true,
      },
    });
    if (!current) throw new NotFoundError('Task', taskId);
    if (current.orchestrationClaimedBy !== workerId) {
      throw new ServiceError('Task is owned by another worker', 'TASK_LEASE_MISMATCH', 409);
    }
    if (![
      TaskOrchestrationStatus.ASSIGNED,
      TaskOrchestrationStatus.RUNNING,
    ].includes(current.orchestrationStatus as TaskOrchestrationStatus)) {
      throw new InvalidStateTransitionError(current.orchestrationStatus, 'HEARTBEAT');
    }

    const updated = await prisma.task.update({
      where: { id: taskId },
      data: { orchestrationHeartbeatAt: now },
      select: {
        id: true,
        projectId: true,
        title: true,
        status: true,
        orchestrationStatus: true,
        orchestrationClaimedBy: true,
        orchestrationClaimedAt: true,
        orchestrationHeartbeatAt: true,
        orchestrationAttemptCount: true,
        orchestrationLastError: true,
      },
    });
    return toTaskOrchestrationTask(updated);
  }

  async recoverStaleClaims(staleAfterMs: number): Promise<RecoverStaleClaimsResult> {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
      throw new ValidationError('staleAfterMs must be a positive number');
    }
    const cutoff = new Date(this.now().getTime() - staleAfterMs);
    const candidates = await prisma.task.findMany({
      where: {
        deletedAt: null,
        orchestrationStatus: {
          in: [TaskOrchestrationStatus.ASSIGNED, TaskOrchestrationStatus.RUNNING],
        },
        OR: [
          { orchestrationHeartbeatAt: { lt: cutoff } },
          { orchestrationHeartbeatAt: null, orchestrationClaimedAt: { lt: cutoff } },
        ],
      },
      select: {
        id: true,
        projectId: true,
        orchestrationStatus: true,
      },
    });

    const recovered: string[] = [];
    for (const candidate of candidates) {
      const didRecover = await prisma.$transaction(async (tx) => {
        const updated = await tx.task.updateMany({
          where: {
            id: candidate.id,
            orchestrationStatus: candidate.orchestrationStatus,
            OR: [
              { orchestrationHeartbeatAt: { lt: cutoff } },
              { orchestrationHeartbeatAt: null, orchestrationClaimedAt: { lt: cutoff } },
            ],
          },
          data: {
            orchestrationStatus: TaskOrchestrationStatus.RECOVERING,
            orchestrationClaimedBy: null,
            orchestrationClaimedAt: null,
            orchestrationHeartbeatAt: null,
            orchestrationLastError: 'Worker lease expired; task returned for recovery',
          },
        });
        if (updated.count !== 1) return false;
        await createTaskEvent(tx, {
          taskId: candidate.id,
          projectId: candidate.projectId,
          type: 'task.recovered',
          fromStatus: candidate.orchestrationStatus,
          toStatus: TaskOrchestrationStatus.RECOVERING,
          payload: { reason: 'worker_lease_expired', cutoff: cutoff.toISOString() },
        });
        return true;
      });
      if (didRecover) {
        recovered.push(candidate.id);
        this.emitOrchestrationUpdated(
          candidate.id,
          candidate.projectId,
          TaskOrchestrationStatus.RECOVERING,
          candidate.orchestrationStatus,
        );
      }
    }

    return { recovered: recovered.length, taskIds: recovered };
  }

  async listEvents(taskId: string, options: { limit?: number; after?: Date } = {}): Promise<SharedTaskEvent[]> {
    const task = await prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { id: true },
    });
    if (!task) throw new NotFoundError('Task', taskId);

    const rows = await prisma.taskEvent.findMany({
      where: {
        taskId,
        ...(options.after ? { createdAt: { gt: options.after } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(500, Math.max(1, options.limit ?? 200)),
    });
    return rows.map((row) => serializeEvent(row as TaskEventRow));
  }

  private boardStatusFor(status: TaskOrchestrationStatus): TaskStatus | undefined {
    switch (status) {
      case TaskOrchestrationStatus.RUNNING:
        return TaskStatus.IN_PROGRESS;
      case TaskOrchestrationStatus.REVIEW:
      case TaskOrchestrationStatus.MERGING:
        return TaskStatus.IN_REVIEW;
      case TaskOrchestrationStatus.DONE:
        return TaskStatus.DONE;
      case TaskOrchestrationStatus.CANCELLED:
        return TaskStatus.CANCELLED;
      default:
        return undefined;
    }
  }

  private emitOrchestrationUpdated(
    taskId: string,
    projectId: string,
    status: string,
    previousStatus?: string,
  ): void {
    this.eventBus?.emit('task:orchestration-updated', {
      taskId,
      projectId,
      status,
      ...(previousStatus ? { previousStatus } : {}),
    });
  }
}

export { VALID_TRANSITIONS as TASK_ORCHESTRATION_TRANSITIONS };
