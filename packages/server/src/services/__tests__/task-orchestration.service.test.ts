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
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

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
      env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
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
});
