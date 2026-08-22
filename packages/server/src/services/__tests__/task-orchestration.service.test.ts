import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TaskOrchestrationStatus } from '@agent-tower/shared';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-orchestration-'));
const dbPath = path.join(testDir, 'test.db');
fs.closeSync(fs.openSync(dbPath, 'w'));
const databaseUrl = `file:${dbPath.replaceAll('\\', '/')}`;
process.env.AGENT_TOWER_DATABASE_URL = databaseUrl;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');
const prismaCliPath = path.join(serverRoot, 'node_modules/prisma/build/index.js');

let TaskOrchestrationService: typeof import('../task-orchestration.service.js').TaskOrchestrationService;
let EventBus: typeof import('../../core/event-bus.js').EventBus;
let prisma: PrismaClient;

describe('TaskOrchestrationService', () => {
  beforeAll(async () => {
    execFileSync(process.execPath, [
      prismaCliPath,
      'db',
      'push',
      '--skip-generate',
      `--schema=${schemaPath}`,
    ], {
      cwd: serverRoot,
      env: { ...process.env, AGENT_TOWER_DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    const serviceModule = await import('../task-orchestration.service.js');
    const eventBusModule = await import('../../core/event-bus.js');
    const utilsModule = await import('../../utils/index.js');
    TaskOrchestrationService = serviceModule.TaskOrchestrationService;
    EventBus = eventBusModule.EventBus;
    prisma = utilsModule.prisma;
  }, 30_000);

  beforeEach(async () => {
    await prisma.taskEvent.deleteMany();
    await prisma.taskDependency.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function createTasks() {
    const project = await prisma.project.create({
      data: { name: 'Orchestration project', repoPath: testDir },
    });
    const prerequisite = await prisma.task.create({
      data: { title: 'Prepare foundation', projectId: project.id, priority: 2 },
    });
    const dependent = await prisma.task.create({
      data: { title: 'Build feature', projectId: project.id, priority: 1 },
    });
    return { project, prerequisite, dependent };
  }

  it('enforces dependencies, claims atomically, and records an event timeline', async () => {
    const { project, prerequisite, dependent } = await createTasks();
    const events: Array<{ taskId: string; status: string }> = [];
    const eventBus = new EventBus();
    eventBus.on('task:orchestration-updated', ({ taskId, status }) => {
      events.push({ taskId, status });
    });
    const service = new TaskOrchestrationService(eventBus);

    await service.addDependency(dependent.id, prerequisite.id);
    await expect(service.markReady(dependent.id)).rejects.toMatchObject({ code: 'TASK_BLOCKED' });

    await service.markReady(prerequisite.id);
    const claimed = await service.claim(prerequisite.id, 'worker-a');
    expect(claimed.orchestrationStatus).toBe(TaskOrchestrationStatus.ASSIGNED);
    events.length = 0;
    await service.heartbeat(prerequisite.id, 'worker-a');
    expect(events).toContainEqual({
      taskId: prerequisite.id,
      status: TaskOrchestrationStatus.ASSIGNED,
    });
    expect(await service.claimNext('worker-b', project.id)).toBeNull();

    await service.transition(prerequisite.id, TaskOrchestrationStatus.RUNNING, { workerId: 'worker-a' });
    await service.transition(prerequisite.id, TaskOrchestrationStatus.REVIEW, { workerId: 'worker-a' });
    await service.transition(prerequisite.id, TaskOrchestrationStatus.DONE);

    const readiness = await service.getReadiness(dependent.id);
    expect(readiness.ready).toBe(false);
    await service.markReady(dependent.id);
    expect((await service.claimNext('worker-b', project.id))?.id).toBe(dependent.id);

    const prerequisiteTimeline = await service.listEvents(prerequisite.id);
    expect(prerequisiteTimeline.map((event) => event.type)).toEqual(expect.arrayContaining([
      'task.claimed',
      'task.started',
      'task.completed',
    ]));
    await expect(service.listEvents(dependent.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'task.dependency_added' })]),
    );
    expect(events).toEqual(expect.arrayContaining([
      { taskId: prerequisite.id, status: TaskOrchestrationStatus.ASSIGNED },
      { taskId: dependent.id, status: TaskOrchestrationStatus.ASSIGNED },
    ]));
  });

  it('rejects cycles in the dependency graph', async () => {
    const { prerequisite, dependent } = await createTasks();
    const service = new TaskOrchestrationService(new EventBus());

    await service.addDependency(dependent.id, prerequisite.id);
    await expect(service.addDependency(prerequisite.id, dependent.id))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('moves an expired worker lease to RECOVERING', async () => {
    const { prerequisite } = await createTasks();
    let now = new Date('2026-08-17T00:00:00.000Z');
    const service = new TaskOrchestrationService(new EventBus(), { now: () => now });

    await service.markReady(prerequisite.id);
    await service.claim(prerequisite.id, 'worker-a');
    now = new Date('2026-08-17T00:11:00.000Z');

    await expect(service.recoverStaleClaims(10 * 60_000)).resolves.toMatchObject({
      recovered: 1,
      taskIds: [prerequisite.id],
    });
    await expect(prisma.task.findUnique({ where: { id: prerequisite.id } }))
      .resolves.toMatchObject({
        orchestrationStatus: TaskOrchestrationStatus.RECOVERING,
        orchestrationClaimedBy: null,
      });
    await expect(service.claimNext('worker-b')).resolves.toMatchObject({
      id: prerequisite.id,
      orchestrationStatus: TaskOrchestrationStatus.ASSIGNED,
    });
  });

  it('creates an idempotent generic workflow DAG and advances eligible nodes', async () => {
    const project = await prisma.project.create({
      data: { name: 'Generic workflow project', repoPath: testDir },
    });
    const root = await prisma.task.create({
      data: {
        title: 'Generate release documentation',
        projectId: project.id,
        orchestrationStatus: TaskOrchestrationStatus.RUNNING,
      },
    });
    const service = new TaskOrchestrationService(new EventBus());
    const input = {
      runId: 'release-001',
      nodes: [
        { key: 'discover', title: 'Discover inputs', role: 'Analyst', dependsOnKeys: [] },
        { key: 'compose', title: 'Compose output', role: 'Writer', dependsOnKeys: ['discover'] },
        { key: 'manual', title: 'Wait for operator', role: 'Operator', dependsOnKeys: [] },
      ],
    };

    const created = await service.createWorkflowDag(root.id, input);
    const repeated = await service.createWorkflowDag(root.id, input);
    expect(created.nodes).toHaveLength(3);
    expect(repeated.nodes.map((node) => node.task.id)).toEqual(created.nodes.map((node) => node.task.id));
    expect(created.nodes.find((node) => node.key === 'discover')?.task.orchestrationStatus)
      .toBe(TaskOrchestrationStatus.READY);
    expect(created.nodes.find((node) => node.key === 'compose')?.task.orchestrationStatus)
      .toBe(TaskOrchestrationStatus.BACKLOG);
    expect(created.nodes.every((node) => node.task.title.startsWith('[Workflow:release-001]'))).toBe(true);

    const discover = created.nodes.find((node) => node.key === 'discover')!;
    const manual = created.nodes.find((node) => node.key === 'manual')!;
    await service.transition(manual.task.id, TaskOrchestrationStatus.BLOCKED, {
      actorType: 'TEAM_CONTROLLER',
      reason: 'Requires an explicit external decision',
    });
    await service.claim(discover.task.id, 'analyst-member');
    await service.transition(discover.task.id, TaskOrchestrationStatus.RUNNING, { workerId: 'analyst-member' });
    await service.transition(discover.task.id, TaskOrchestrationStatus.REVIEW, { workerId: 'analyst-member' });
    const advanced = await service.completeWorkflowTask(
      root.id,
      input.runId,
      discover.task.id,
      { actorType: 'TEAM_CONTROLLER', actorId: 'controller-member' },
    );
    expect(advanced.nodes.find((node) => node.key === 'compose')?.task.orchestrationStatus)
      .toBe(TaskOrchestrationStatus.READY);
    expect(advanced.nodes.find((node) => node.key === 'manual')?.task.orchestrationStatus)
      .toBe(TaskOrchestrationStatus.BLOCKED);

    await expect(service.createWorkflowDag(root.id, {
      runId: input.runId,
      nodes: [
        { key: 'discover', title: 'Discover inputs', role: 'Analyst', dependsOnKeys: ['compose'] },
      ],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('pauses only the affected DAG branch for human input and resumes from the durable answer', async () => {
    const project = await prisma.project.create({
      data: { name: 'Human decision workflow', repoPath: testDir },
    });
    const root = await prisma.task.create({
      data: {
        title: 'Generate FSD',
        projectId: project.id,
        orchestrationStatus: TaskOrchestrationStatus.RUNNING,
      },
    });
    const service = new TaskOrchestrationService(new EventBus());
    const runId = 'fsd-human-001';
    const created = await service.createWorkflowDag(root.id, {
      runId,
      nodes: [
        { key: 'scope', title: 'Resolve scope', role: 'Analyst', dependsOnKeys: [] },
        { key: 'extract', title: 'Extract findings', role: 'Analyst', dependsOnKeys: ['scope'] },
        { key: 'independent', title: 'Read glossary', role: 'Analyst B', dependsOnKeys: [] },
      ],
    });
    const scope = created.nodes.find((node) => node.key === 'scope')!;
    await service.claim(scope.task.id, 'analyst-a');
    await service.transition(scope.task.id, TaskOrchestrationStatus.RUNNING, { workerId: 'analyst-a' });

    const requested = await service.requestHumanInput(
      root.id,
      runId,
      scope.task.id,
      {
        requestKey: 'source-root-choice',
        question: 'Which source root should be used?',
        options: ['webflow', 'batch'],
        allowFreeText: false,
      },
      { workerId: 'analyst-a', actorType: 'TEAM_MEMBER', actorId: 'analyst-a' },
    );
    expect(requested.task).toMatchObject({
      orchestrationStatus: TaskOrchestrationStatus.WAITING_INPUT,
      orchestrationClaimedBy: null,
    });

    const waitingDag = await service.getWorkflowDag(root.id, runId);
    expect(waitingDag.nodes.find((node) => node.key === 'scope')).toMatchObject({
      humanInput: {
        questionId: requested.humanInput.questionId,
        status: 'WAITING',
        options: ['webflow', 'batch'],
      },
      task: { orchestrationStatus: TaskOrchestrationStatus.WAITING_INPUT },
    });
    expect(waitingDag.nodes.find((node) => node.key === 'extract')?.task.orchestrationStatus)
      .toBe(TaskOrchestrationStatus.BACKLOG);
    expect(waitingDag.nodes.find((node) => node.key === 'independent')?.task.orchestrationStatus)
      .toBe(TaskOrchestrationStatus.READY);

    await expect(service.answerHumanInput(
      root.id,
      runId,
      scope.task.id,
      requested.humanInput.questionId,
      'unknown',
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const answered = await service.answerHumanInput(
      root.id,
      runId,
      scope.task.id,
      requested.humanInput.questionId,
      'webflow',
      { actorType: 'USER' },
    );
    expect(answered).toMatchObject({
      resumed: true,
      task: { orchestrationStatus: TaskOrchestrationStatus.READY },
      humanInput: { status: 'ANSWERED', answer: 'webflow' },
    });
    await expect(service.answerHumanInput(
      root.id,
      runId,
      scope.task.id,
      requested.humanInput.questionId,
      'webflow',
      { actorType: 'USER' },
    )).resolves.toMatchObject({ resumed: false });

    const resumedDag = await service.getWorkflowDag(root.id, runId);
    expect(resumedDag.nodes.find((node) => node.key === 'scope')?.humanInput)
      .toMatchObject({ status: 'ANSWERED', answer: 'webflow' });
    await expect(service.requestHumanInput(
      root.id,
      runId,
      scope.task.id,
      {
        requestKey: 'source-root-choice',
        question: 'Which source root should be used?',
        options: ['webflow', 'batch'],
        allowFreeText: false,
      },
      { workerId: 'analyst-a', actorType: 'TEAM_MEMBER', actorId: 'analyst-a' },
    )).resolves.toMatchObject({
      task: { orchestrationStatus: TaskOrchestrationStatus.READY },
      humanInput: { status: 'ANSWERED', answer: 'webflow' },
    });
    expect((await service.listEvents(scope.task.id)).map((event) => event.type)).toEqual(
      expect.arrayContaining(['task.human_input_requested', 'task.human_input_answered']),
    );
  });
});
