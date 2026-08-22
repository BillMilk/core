import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  TaskOrchestrationStatus,
  TaskStatus,
  type TaskDependency as SharedTaskDependency,
  type TaskDependencyResponse,
  type TaskEvent as SharedTaskEvent,
  type TaskEventType,
  type TaskHumanInput,
  type TaskReadinessResponse,
  type TaskWorkflowDag,
  type TaskWorkflowNodeInput,
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
    TaskOrchestrationStatus.WAITING_INPUT,
    TaskOrchestrationStatus.REVIEW,
    TaskOrchestrationStatus.BLOCKED,
    TaskOrchestrationStatus.HANDOFF,
    TaskOrchestrationStatus.RECOVERING,
    TaskOrchestrationStatus.CANCELLED,
  ],
  [TaskOrchestrationStatus.WAITING_INPUT]: [
    TaskOrchestrationStatus.READY,
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

export interface TaskWorkflowMutationInput {
  runId: string;
  nodes: TaskWorkflowNodeInput[];
}

export interface RequestTaskHumanInput {
  requestKey: string;
  question: string;
  context?: string;
  options?: string[];
  allowFreeText?: boolean;
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

interface WorkflowNodeEventPayload extends TaskWorkflowNodeInput {
  rootTaskId: string;
  runId: string;
  nodeKey: string;
  taskId: string;
}

interface HumanInputRequestedPayload {
  questionId: string;
  rootTaskId: string;
  runId: string;
  nodeKey: string;
  taskId: string;
  requestKey: string;
  question: string;
  context?: string;
  options: string[];
  allowFreeText: boolean;
  requestedByMemberId?: string | null;
  requestedAt: string;
}

interface HumanInputAnsweredPayload {
  questionId: string;
  answer: string;
  answeredAt: string;
  answeredBy?: string | null;
}

function asWorkflowNodePayload(payload: unknown): WorkflowNodeEventPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.rootTaskId !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.nodeKey !== 'string'
    || typeof value.taskId !== 'string'
    || typeof value.role !== 'string'
  ) {
    return null;
  }
  return {
    rootTaskId: value.rootTaskId,
    runId: value.runId,
    nodeKey: value.nodeKey,
    taskId: value.taskId,
    key: value.nodeKey,
    title: typeof value.title === 'string' ? value.title : value.nodeKey,
    description: typeof value.description === 'string' ? value.description : undefined,
    role: value.role,
    promptFile: typeof value.promptFile === 'string' ? value.promptFile : undefined,
    outputPaths: Array.isArray(value.outputPaths)
      ? value.outputPaths.filter((item): item is string => typeof item === 'string')
      : [],
    verifyId: typeof value.verifyId === 'string' ? value.verifyId : undefined,
    dependsOnKeys: Array.isArray(value.dependsOnKeys)
      ? value.dependsOnKeys.filter((item): item is string => typeof item === 'string')
      : [],
    priority: typeof value.priority === 'number' ? value.priority : undefined,
  };
}

function workflowNodeIdempotencyKey(rootTaskId: string, runId: string, nodeKey: string): string {
  return `workflow:${rootTaskId}:${runId}:${nodeKey}`;
}

function workflowInitIdempotencyKey(rootTaskId: string, runId: string): string {
  return `workflow:${rootTaskId}:${runId}:initialized`;
}

function workflowCompleteIdempotencyKey(rootTaskId: string, runId: string): string {
  return `workflow:${rootTaskId}:${runId}:completed`;
}

function humanInputRequestIdempotencyKey(
  rootTaskId: string,
  runId: string,
  nodeKey: string,
  requestKey: string,
): string {
  return `workflow:${rootTaskId}:${runId}:${nodeKey}:human-input:${requestKey}`;
}

function humanInputAnswerIdempotencyKey(questionId: string): string {
  return `human-input:${questionId}:answered`;
}

function asHumanInputRequestedPayload(payload: unknown): HumanInputRequestedPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.questionId !== 'string'
    || typeof value.rootTaskId !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.nodeKey !== 'string'
    || typeof value.taskId !== 'string'
    || typeof value.requestKey !== 'string'
    || typeof value.question !== 'string'
    || typeof value.requestedAt !== 'string'
  ) return null;
  return {
    questionId: value.questionId,
    rootTaskId: value.rootTaskId,
    runId: value.runId,
    nodeKey: value.nodeKey,
    taskId: value.taskId,
    requestKey: value.requestKey,
    question: value.question,
    ...(typeof value.context === 'string' ? { context: value.context } : {}),
    options: Array.isArray(value.options)
      ? value.options.filter((option): option is string => typeof option === 'string')
      : [],
    allowFreeText: value.allowFreeText !== false,
    requestedByMemberId: typeof value.requestedByMemberId === 'string'
      ? value.requestedByMemberId
      : null,
    requestedAt: value.requestedAt,
  };
}

function asHumanInputAnsweredPayload(payload: unknown): HumanInputAnsweredPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.questionId !== 'string'
    || typeof value.answer !== 'string'
    || typeof value.answeredAt !== 'string'
  ) return null;
  return {
    questionId: value.questionId,
    answer: value.answer,
    answeredAt: value.answeredAt,
    answeredBy: typeof value.answeredBy === 'string' ? value.answeredBy : null,
  };
}

function requestedPayloadToHumanInput(request: HumanInputRequestedPayload): TaskHumanInput {
  return {
    questionId: request.questionId,
    rootTaskId: request.rootTaskId,
    runId: request.runId,
    nodeKey: request.nodeKey,
    taskId: request.taskId,
    question: request.question,
    ...(request.context ? { context: request.context } : {}),
    options: request.options,
    allowFreeText: request.allowFreeText,
    requestedByMemberId: request.requestedByMemberId ?? null,
    requestedAt: request.requestedAt,
    status: 'WAITING',
  };
}

function buildLatestHumanInputs(rows: Array<{ taskId: string; type: string; payload: string | null }>): Map<string, TaskHumanInput> {
  const byQuestionId = new Map<string, TaskHumanInput>();
  const latestByTaskId = new Map<string, TaskHumanInput>();
  for (const row of rows) {
    if (row.type === 'task.human_input_requested') {
      const request = asHumanInputRequestedPayload(parsePayload(row.payload));
      if (!request) continue;
      const humanInput = requestedPayloadToHumanInput(request);
      byQuestionId.set(request.questionId, humanInput);
      latestByTaskId.set(row.taskId, humanInput);
      continue;
    }
    if (row.type === 'task.human_input_answered') {
      const answer = asHumanInputAnsweredPayload(parsePayload(row.payload));
      if (!answer) continue;
      const request = byQuestionId.get(answer.questionId);
      if (!request) continue;
      const answered: TaskHumanInput = {
        ...request,
        status: 'ANSWERED',
        answer: answer.answer,
        answeredAt: answer.answeredAt,
        answeredBy: answer.answeredBy ?? null,
      };
      byQuestionId.set(answer.questionId, answered);
      latestByTaskId.set(row.taskId, answered);
    }
  }
  return latestByTaskId;
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

  /**
   * Materialize or extend an idempotent workflow using ordinary tasks and
   * dependency edges. TaskEvent is the workflow metadata registry, while the
   * Task row remains the only mutable status record.
   */
  async createWorkflowDag(
    rootTaskId: string,
    input: TaskWorkflowMutationInput,
  ): Promise<TaskWorkflowDag> {
    const runId = input.runId.trim();
    if (!runId) throw new ValidationError('runId is required');
    if (input.nodes.length === 0) throw new ValidationError('At least one workflow node is required');

    const duplicateKeys = input.nodes
      .map((node) => node.key.trim())
      .filter((key, index, keys) => keys.indexOf(key) !== index);
    if (duplicateKeys.length > 0) {
      throw new ValidationError(`Duplicate workflow node keys: ${[...new Set(duplicateKeys)].join(', ')}`);
    }

    const root = await prisma.task.findFirst({
      where: { id: rootTaskId, deletedAt: null },
      select: { id: true, projectId: true },
    });
    if (!root) throw new NotFoundError('Task', rootTaskId);

    await prisma.$transaction(async (tx) => {
      const workflowEvents = await tx.taskEvent.findMany({
        where: { projectId: root.projectId, type: 'workflow.node_created' },
        select: { payload: true },
      });
      const existingByKey = new Map<string, WorkflowNodeEventPayload>();
      for (const event of workflowEvents) {
        const payload = asWorkflowNodePayload(parsePayload(event.payload));
        if (payload?.rootTaskId === rootTaskId && payload.runId === runId) {
          existingByKey.set(payload.nodeKey, payload);
        }
      }

      const requestedKeys = new Set(input.nodes.map((node) => node.key.trim()));
      const knownKeys = new Set([...existingByKey.keys(), ...requestedKeys]);
      for (const node of input.nodes) {
        const key = node.key.trim();
        if (!key || !node.title.trim() || !node.role.trim()) {
          throw new ValidationError('Workflow node key, title, and role are required');
        }
        for (const dependencyKey of node.dependsOnKeys ?? []) {
          if (!knownKeys.has(dependencyKey)) {
            throw new ValidationError(`Unknown dependency key '${dependencyKey}' for node '${key}'`);
          }
          if (dependencyKey === key) {
            throw new ValidationError(`Workflow node '${key}' cannot depend on itself`);
          }
        }
      }

      const taskIdByKey = new Map<string, string>();
      for (const [key, payload] of existingByKey) taskIdByKey.set(key, payload.taskId);

      for (const node of input.nodes) {
        const key = node.key.trim();
        if (taskIdByKey.has(key)) continue;
        const description = [
          '[Agent Tower Workflow Node]',
          `rootTaskId: ${rootTaskId}`,
          `runId: ${runId}`,
          `nodeKey: ${key}`,
          `role: ${node.role.trim()}`,
          '',
          node.description?.trim() ?? '',
        ].join('\n').trim();
        const task = await tx.task.create({
          data: {
            projectId: root.projectId,
            title: `[Workflow:${runId}] ${key} ${node.title.trim()}`,
            description,
            priority: node.priority ?? 0,
            orchestrationStatus: TaskOrchestrationStatus.BACKLOG,
          },
          select: { id: true },
        });
        taskIdByKey.set(key, task.id);
        await createTaskEvent(tx, {
          taskId: task.id,
          projectId: root.projectId,
          type: 'workflow.node_created',
          actorType: 'WORKFLOW',
          payload: {
            ...node,
            key,
            title: node.title.trim(),
            role: node.role.trim(),
            rootTaskId,
            runId,
            nodeKey: key,
            taskId: task.id,
            outputPaths: node.outputPaths ?? [],
            dependsOnKeys: node.dependsOnKeys ?? [],
          },
          idempotencyKey: workflowNodeIdempotencyKey(rootTaskId, runId, key),
        });
      }

      const allWorkflowTaskIds = [...taskIdByKey.values()];
      const existingEdges = await tx.taskDependency.findMany({
        where: { taskId: { in: allWorkflowTaskIds }, dependsOnTaskId: { in: allWorkflowTaskIds } },
        select: { taskId: true, dependsOnTaskId: true },
      });
      const adjacency = new Map<string, Set<string>>();
      for (const edge of existingEdges) {
        const values = adjacency.get(edge.taskId) ?? new Set<string>();
        values.add(edge.dependsOnTaskId);
        adjacency.set(edge.taskId, values);
      }

      for (const node of input.nodes) {
        const taskId = taskIdByKey.get(node.key.trim())!;
        for (const dependencyKey of node.dependsOnKeys ?? []) {
          const dependsOnTaskId = taskIdByKey.get(dependencyKey)!;
          const alreadyLinked = adjacency.get(taskId)?.has(dependsOnTaskId) ?? false;
          const pending = [dependsOnTaskId];
          const visited = new Set<string>();
          while (pending.length > 0) {
            const current = pending.pop()!;
            if (current === taskId) {
              throw new ValidationError(`Workflow dependency '${node.key}' -> '${dependencyKey}' would create a cycle`);
            }
            if (visited.has(current)) continue;
            visited.add(current);
            pending.push(...(adjacency.get(current) ?? []));
          }
          await tx.taskDependency.upsert({
            where: { taskId_dependsOnTaskId: { taskId, dependsOnTaskId } },
            create: { taskId, dependsOnTaskId },
            update: {},
          });
          const values = adjacency.get(taskId) ?? new Set<string>();
          values.add(dependsOnTaskId);
          adjacency.set(taskId, values);
          if (!alreadyLinked) {
            await createTaskEvent(tx, {
              taskId,
              projectId: root.projectId,
              type: 'task.dependency_added',
              actorType: 'WORKFLOW',
              payload: { dependsOnTaskId, dependsOnKey: dependencyKey, rootTaskId, runId },
            });
          }
        }
      }

      const initKey = workflowInitIdempotencyKey(rootTaskId, runId);
      const initialized = await tx.taskEvent.findUnique({ where: { idempotencyKey: initKey } });
      if (!initialized) {
        await createTaskEvent(tx, {
          taskId: rootTaskId,
          projectId: root.projectId,
          type: 'workflow.initialized',
          actorType: 'WORKFLOW',
          payload: { rootTaskId, runId },
          idempotencyKey: initKey,
        });
      }

      const candidates = await tx.task.findMany({
        where: {
          id: { in: allWorkflowTaskIds },
          orchestrationStatus: TaskOrchestrationStatus.BACKLOG,
          dependencies: {
            every: { dependsOnTask: { OR: [...DEPENDENCY_COMPLETE_OR] } },
          },
        },
        select: { id: true, orchestrationStatus: true },
      });
      for (const candidate of candidates) {
        await tx.task.update({
          where: { id: candidate.id },
          data: { orchestrationStatus: TaskOrchestrationStatus.READY },
        });
        await createTaskEvent(tx, {
          taskId: candidate.id,
          projectId: root.projectId,
          type: 'task.released',
          fromStatus: candidate.orchestrationStatus,
          toStatus: TaskOrchestrationStatus.READY,
          actorType: 'WORKFLOW',
          payload: { reason: 'dependencies_satisfied', rootTaskId, runId },
        });
      }
    });

    const dag = await this.getWorkflowDag(rootTaskId, runId);
    for (const node of dag.nodes) {
      this.emitOrchestrationUpdated(
        node.task.id,
        dag.projectId,
        node.task.orchestrationStatus ?? TaskOrchestrationStatus.BACKLOG,
      );
    }
    return dag;
  }

  async getWorkflowDag(rootTaskId: string, runId: string): Promise<TaskWorkflowDag> {
    const root = await prisma.task.findFirst({
      where: { id: rootTaskId, deletedAt: null },
      select: { id: true, projectId: true },
    });
    if (!root) throw new NotFoundError('Task', rootTaskId);

    const events = await prisma.taskEvent.findMany({
      where: { projectId: root.projectId, type: 'workflow.node_created' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { payload: true },
    });
    const payloads = events
      .map((event) => asWorkflowNodePayload(parsePayload(event.payload)))
      .filter((payload): payload is WorkflowNodeEventPayload => (
        payload?.rootTaskId === rootTaskId && payload.runId === runId
      ));
    if (payloads.length === 0) {
      throw new NotFoundError('TaskWorkflow', `${rootTaskId}:${runId}`);
    }

    const taskIds = payloads.map((payload) => payload.taskId);
    const [tasks, dependencies, humanInputEvents] = await Promise.all([
      prisma.task.findMany({
        where: { id: { in: taskIds }, deletedAt: null },
        select: {
          id: true,
          projectId: true,
          title: true,
          description: true,
          status: true,
          orchestrationStatus: true,
          orchestrationClaimedBy: true,
          orchestrationClaimedAt: true,
          orchestrationHeartbeatAt: true,
          orchestrationAttemptCount: true,
          orchestrationLastError: true,
          priority: true,
        },
      }),
      prisma.taskDependency.findMany({
        where: { taskId: { in: taskIds }, dependsOnTaskId: { in: taskIds } },
        select: { taskId: true, dependsOnTaskId: true },
      }),
      prisma.taskEvent.findMany({
        where: {
          taskId: { in: taskIds },
          type: { in: ['task.human_input_requested', 'task.human_input_answered'] },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { taskId: true, type: true, payload: true },
      }),
    ]);
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const keyByTaskId = new Map(payloads.map((payload) => [payload.taskId, payload.nodeKey]));
    const latestHumanInputByTaskId = buildLatestHumanInputs(humanInputEvents);
    const counts: TaskWorkflowDag['counts'] = {};
    const nodes = payloads.flatMap((payload) => {
      const task = taskById.get(payload.taskId);
      if (!task) return [];
      const orchestrationStatus = task.orchestrationStatus as TaskOrchestrationStatus;
      counts[orchestrationStatus] = (counts[orchestrationStatus] ?? 0) + 1;
      return [{
        key: payload.nodeKey,
        role: payload.role,
        ...(payload.promptFile ? { promptFile: payload.promptFile } : {}),
        outputPaths: payload.outputPaths ?? [],
        ...(payload.verifyId ? { verifyId: payload.verifyId } : {}),
        ...(latestHumanInputByTaskId.get(task.id)
          ? { humanInput: latestHumanInputByTaskId.get(task.id) }
          : {}),
        dependsOnKeys: dependencies
          .filter((edge) => edge.taskId === task.id)
          .map((edge) => keyByTaskId.get(edge.dependsOnTaskId))
          .filter((key): key is string => Boolean(key)),
        task: {
          ...task,
          description: task.description ?? undefined,
          status: task.status as TaskStatus,
          orchestrationStatus,
          orchestrationClaimedAt: task.orchestrationClaimedAt?.toISOString() ?? null,
          orchestrationHeartbeatAt: task.orchestrationHeartbeatAt?.toISOString() ?? null,
        },
      }];
    });

    return {
      rootTaskId,
      projectId: root.projectId,
      runId,
      nodes,
      edges: dependencies.flatMap((edge) => {
        const taskKey = keyByTaskId.get(edge.taskId);
        const dependsOnKey = keyByTaskId.get(edge.dependsOnTaskId);
        return taskKey && dependsOnKey ? [{ taskKey, dependsOnKey }] : [];
      }),
      counts,
    };
  }

  async listTaskWorkflows(rootTaskId: string): Promise<TaskWorkflowDag[]> {
    const root = await prisma.task.findFirst({
      where: { id: rootTaskId, deletedAt: null },
      select: { id: true },
    });
    if (!root) throw new NotFoundError('Task', rootTaskId);
    const events = await prisma.taskEvent.findMany({
      where: { taskId: rootTaskId, type: 'workflow.initialized' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { payload: true },
    });
    const runIds = events.flatMap((event) => {
      const payload = parsePayload(event.payload);
      if (!payload || typeof payload !== 'object') return [];
      const runId = (payload as Record<string, unknown>).runId;
      return typeof runId === 'string' ? [runId] : [];
    });
    return Promise.all([...new Set(runIds)].map((runId) => this.getWorkflowDag(rootTaskId, runId)));
  }

  async assertWorkflowTask(rootTaskId: string, runId: string, taskId: string) {
    const dag = await this.getWorkflowDag(rootTaskId, runId);
    const node = dag.nodes.find((item) => item.task.id === taskId);
    if (!node) throw new ValidationError('Task is not a node in the current workflow');
    return { dag, node };
  }

  async requestHumanInput(
    rootTaskId: string,
    runId: string,
    taskId: string,
    input: RequestTaskHumanInput,
    options: TaskOrchestrationTransitionOptions = {},
  ) {
    const { node } = await this.assertWorkflowTask(rootTaskId, runId, taskId);
    const requestKey = input.requestKey.trim();
    const question = input.question.trim();
    const context = input.context?.trim();
    const choices = [...new Set((input.options ?? []).map((option) => option.trim()).filter(Boolean))];
    if (!requestKey) throw new ValidationError('requestKey is required');
    if (!question) throw new ValidationError('question is required');
    if (choices.length > 20) throw new ValidationError('Human input supports at most 20 options');
    const allowFreeText = input.allowFreeText ?? choices.length === 0;
    if (!allowFreeText && choices.length === 0) {
      throw new ValidationError('At least one option is required when free text is disabled');
    }

    const idempotencyKey = humanInputRequestIdempotencyKey(rootTaskId, runId, node.key, requestKey);
    const existing = await prisma.taskEvent.findUnique({
      where: { idempotencyKey },
      select: { payload: true },
    });
    const existingRequest = asHumanInputRequestedPayload(parsePayload(existing?.payload ?? null));
    if (existingRequest) {
      const task = await this.getOrchestrationTask(taskId);
      const humanInput = node.humanInput?.questionId === existingRequest.questionId
        ? node.humanInput
        : requestedPayloadToHumanInput(existingRequest);
      return { humanInput, task };
    }

    const now = this.now();
    const request: HumanInputRequestedPayload = {
      questionId: randomUUID(),
      rootTaskId,
      runId,
      nodeKey: node.key,
      taskId,
      requestKey,
      question,
      ...(context ? { context } : {}),
      options: choices,
      allowFreeText,
      requestedByMemberId: options.actorId ?? options.workerId ?? null,
      requestedAt: now.toISOString(),
    };

    const updated = await prisma.$transaction(async (tx) => {
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
      if (task.orchestrationStatus !== TaskOrchestrationStatus.RUNNING) {
        throw new InvalidStateTransitionError(task.orchestrationStatus, TaskOrchestrationStatus.WAITING_INPUT);
      }
      if (options.workerId && task.orchestrationClaimedBy !== options.workerId) {
        throw new ServiceError('Task is owned by another worker', 'TASK_LEASE_MISMATCH', 409);
      }
      const result = await tx.task.update({
        where: { id: taskId },
        data: {
          orchestrationStatus: TaskOrchestrationStatus.WAITING_INPUT,
          orchestrationClaimedBy: null,
          orchestrationClaimedAt: null,
          orchestrationHeartbeatAt: null,
          orchestrationLastError: null,
          status: TaskStatus.IN_PROGRESS,
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
        type: 'task.human_input_requested',
        fromStatus: task.orchestrationStatus,
        toStatus: TaskOrchestrationStatus.WAITING_INPUT,
        actorType: options.actorType ?? (options.workerId ? 'TEAM_MEMBER' : 'SYSTEM'),
        actorId: options.actorId ?? options.workerId,
        payload: request,
        idempotencyKey,
      });
      return result;
    });

    this.emitOrchestrationUpdated(
      taskId,
      updated.projectId,
      TaskOrchestrationStatus.WAITING_INPUT,
      TaskOrchestrationStatus.RUNNING,
    );
    return { humanInput: requestedPayloadToHumanInput(request), task: toTaskOrchestrationTask(updated) };
  }

  async answerHumanInput(
    rootTaskId: string,
    runId: string,
    taskId: string,
    questionId: string,
    answerValue: string,
    options: { actorType?: string; actorId?: string } = {},
  ) {
    const { node } = await this.assertWorkflowTask(rootTaskId, runId, taskId);
    const answer = answerValue.trim();
    if (!answer) throw new ValidationError('answer is required');

    const requestRows = await prisma.taskEvent.findMany({
      where: { taskId, type: 'task.human_input_requested' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { payload: true },
    });
    const request = requestRows
      .map((row) => asHumanInputRequestedPayload(parsePayload(row.payload)))
      .find((candidate) => candidate?.questionId === questionId);
    if (!request || request.rootTaskId !== rootTaskId || request.runId !== runId || request.nodeKey !== node.key) {
      throw new NotFoundError('TaskHumanInput', questionId);
    }
    if (!request.allowFreeText && !request.options.includes(answer)) {
      throw new ValidationError('answer must match one of the provided options');
    }

    const answerKey = humanInputAnswerIdempotencyKey(questionId);
    const existingAnswerEvent = await prisma.taskEvent.findUnique({
      where: { idempotencyKey: answerKey },
      select: { payload: true },
    });
    const existingAnswer = asHumanInputAnsweredPayload(parsePayload(existingAnswerEvent?.payload ?? null));
    if (existingAnswer) {
      return {
        humanInput: {
          ...requestedPayloadToHumanInput(request),
          status: 'ANSWERED' as const,
          answer: existingAnswer.answer,
          answeredAt: existingAnswer.answeredAt,
          answeredBy: existingAnswer.answeredBy ?? null,
        },
        task: await this.getOrchestrationTask(taskId),
        resumed: false,
      };
    }

    const answeredAt = this.now();
    const answerPayload: HumanInputAnsweredPayload = {
      questionId,
      answer,
      answeredAt: answeredAt.toISOString(),
      answeredBy: options.actorId ?? null,
    };
    const updated = await prisma.$transaction(async (tx) => {
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
              dependsOnTask: { select: { status: true, orchestrationStatus: true } },
            },
          },
        },
      });
      if (!task) throw new NotFoundError('Task', taskId);
      if (task.orchestrationStatus !== TaskOrchestrationStatus.WAITING_INPUT) {
        throw new InvalidStateTransitionError(task.orchestrationStatus, TaskOrchestrationStatus.READY);
      }
      const hasBlocker = task.dependencies.some(({ dependsOnTask }) => (
        dependsOnTask.orchestrationStatus !== TaskOrchestrationStatus.DONE
        && dependsOnTask.status !== TaskStatus.DONE
      ));
      if (hasBlocker) throw new ServiceError('Task has incomplete dependencies', 'TASK_BLOCKED', 409);
      const result = await tx.task.update({
        where: { id: taskId },
        data: {
          orchestrationStatus: TaskOrchestrationStatus.READY,
          orchestrationClaimedBy: null,
          orchestrationClaimedAt: null,
          orchestrationHeartbeatAt: null,
          orchestrationLastError: null,
          status: TaskStatus.IN_PROGRESS,
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
        type: 'task.human_input_answered',
        fromStatus: TaskOrchestrationStatus.WAITING_INPUT,
        toStatus: TaskOrchestrationStatus.READY,
        actorType: options.actorType ?? 'USER',
        actorId: options.actorId,
        payload: answerPayload,
        idempotencyKey: answerKey,
      });
      return result;
    });

    this.emitOrchestrationUpdated(
      taskId,
      updated.projectId,
      TaskOrchestrationStatus.READY,
      TaskOrchestrationStatus.WAITING_INPUT,
    );
    return {
      humanInput: {
        ...requestedPayloadToHumanInput(request),
        status: 'ANSWERED' as const,
        answer,
        answeredAt: answerPayload.answeredAt,
        answeredBy: answerPayload.answeredBy ?? null,
      },
      task: toTaskOrchestrationTask(updated),
      resumed: true,
    };
  }

  private async getOrchestrationTask(taskId: string): Promise<TaskOrchestrationTask> {
    const task = await prisma.task.findFirst({
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
    return toTaskOrchestrationTask(task);
  }

  async completeWorkflowTask(
    rootTaskId: string,
    runId: string,
    taskId: string,
    options: TaskOrchestrationTransitionOptions = {},
  ): Promise<TaskWorkflowDag> {
    await this.assertWorkflowTask(rootTaskId, runId, taskId);
    await this.transition(taskId, TaskOrchestrationStatus.DONE, options);
    let dag = await this.getWorkflowDag(rootTaskId, runId);
    const completedTaskIds = new Set(
      dag.nodes
        .filter((node) => node.task.orchestrationStatus === TaskOrchestrationStatus.DONE)
        .map((node) => node.task.id),
    );
    const taskIdByKey = new Map(dag.nodes.map((node) => [node.key, node.task.id]));
    const completedNodeKey = dag.nodes.find((node) => node.task.id === taskId)?.key;
    for (const node of dag.nodes) {
      if (![TaskOrchestrationStatus.BACKLOG, TaskOrchestrationStatus.BLOCKED].includes(
        node.task.orchestrationStatus ?? TaskOrchestrationStatus.BACKLOG,
      )) continue;
      if (
        node.task.orchestrationStatus === TaskOrchestrationStatus.BLOCKED
        && (!completedNodeKey || !node.dependsOnKeys.includes(completedNodeKey))
      ) continue;
      const dependenciesDone = node.dependsOnKeys.every((key) => {
        const dependencyTaskId = taskIdByKey.get(key);
        return dependencyTaskId ? completedTaskIds.has(dependencyTaskId) : false;
      });
      if (dependenciesDone) {
        await this.markReady(node.task.id, {
          actorType: 'WORKFLOW',
          actorId: options.actorId,
        });
      }
    }

    dag = await this.getWorkflowDag(rootTaskId, runId);
    if (dag.nodes.every((node) => node.task.orchestrationStatus === TaskOrchestrationStatus.DONE)) {
      const completeKey = workflowCompleteIdempotencyKey(rootTaskId, runId);
      const existing = await prisma.taskEvent.findUnique({ where: { idempotencyKey: completeKey } });
      if (!existing) {
        await appendTaskEvent({
          taskId: rootTaskId,
          projectId: dag.projectId,
          type: 'workflow.completed',
          actorType: 'WORKFLOW',
          actorId: options.actorId,
          payload: { rootTaskId, runId },
          idempotencyKey: completeKey,
        });
      }
      const root = await prisma.task.findUnique({
        where: { id: rootTaskId },
        select: { orchestrationStatus: true },
      });
      if (root?.orchestrationStatus === TaskOrchestrationStatus.RUNNING) {
        await this.transition(rootTaskId, TaskOrchestrationStatus.REVIEW, {
          actorType: 'WORKFLOW',
          actorId: options.actorId,
        });
      }
      const refreshedRoot = await prisma.task.findUnique({
        where: { id: rootTaskId },
        select: { orchestrationStatus: true },
      });
      if (refreshedRoot?.orchestrationStatus === TaskOrchestrationStatus.REVIEW) {
        await this.transition(rootTaskId, TaskOrchestrationStatus.DONE, {
          actorType: 'WORKFLOW',
          actorId: options.actorId,
        });
      }
    }
    return dag;
  }

  async addDependency(taskId: string, dependsOnTaskId: string): Promise<SharedTaskDependency> {
    if (taskId === dependsOnTaskId) {
      throw new ValidationError('A task cannot depend on itself');
    }

    const task = await prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { id: true, projectId: true, orchestrationStatus: true },
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

    const dependency = await prisma.$transaction(async (tx) => {
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
    this.emitOrchestrationUpdated(task.id, task.projectId, task.orchestrationStatus);
    return dependency;
  }

  async removeDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    const task = await prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { id: true, projectId: true, orchestrationStatus: true },
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
    this.emitOrchestrationUpdated(task.id, task.projectId, task.orchestrationStatus);
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
    if (readiness.orchestrationStatus === TaskOrchestrationStatus.WAITING_INPUT) {
      throw new ServiceError(
        'Task is waiting for a structured human answer',
        'HUMAN_INPUT_REQUIRED',
        409,
      );
    }
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
        TaskOrchestrationStatus.WAITING_INPUT,
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
    this.emitOrchestrationUpdated(
      updated.id,
      updated.projectId,
      updated.orchestrationStatus,
      current.orchestrationStatus,
    );
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
      case TaskOrchestrationStatus.WAITING_INPUT:
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
