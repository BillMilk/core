import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TaskOrchestrationStatus } from '@agent-tower/shared';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-orchestration-routes-'));
const dbPath = path.join(testDir, 'test.db');
fs.closeSync(fs.openSync(dbPath, 'w'));
const databaseUrl = `file:${dbPath.replaceAll('\\', '/')}`;
process.env.AGENT_TOWER_DATABASE_URL = databaseUrl;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');
const prismaCliPath = path.join(serverRoot, 'node_modules/prisma/build/index.js');

let taskRoutes: typeof import('../tasks.js').taskRoutes;
let prisma: PrismaClient;

describe('task orchestration routes', () => {
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

    taskRoutes = (await import('../tasks.js')).taskRoutes;
    prisma = (await import('../../utils/index.js')).prisma;
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

  it('exposes dependency-aware claim and transition endpoints', async () => {
    const project = await prisma.project.create({
      data: { name: 'Orchestration route project', repoPath: testDir },
    });
    const prerequisite = await prisma.task.create({
      data: { title: 'Prerequisite', projectId: project.id, priority: 2 },
    });
    const dependent = await prisma.task.create({
      data: { title: 'Dependent', projectId: project.id, priority: 1 },
    });
    const app = Fastify();
    await app.register(taskRoutes, { prefix: '/api' });

    try {
      const dependencyResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${dependent.id}/dependencies`,
        payload: { dependsOnTaskId: prerequisite.id },
      });
      expect(dependencyResponse.statusCode).toBe(201);

      const blockedReadyResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${dependent.id}/orchestration/ready`,
      });
      expect(blockedReadyResponse.statusCode).toBe(409);
      expect(blockedReadyResponse.json().code).toBe('TASK_BLOCKED');

      await expect(app.inject({
        method: 'POST',
        url: `/api/tasks/${prerequisite.id}/orchestration/ready`,
      })).resolves.toMatchObject({ statusCode: 200 });

      const claimResponse = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks/claim-next`,
        payload: { workerId: 'route-worker' },
      });
      expect(claimResponse.statusCode).toBe(200);
      expect(claimResponse.json()).toMatchObject({
        id: prerequisite.id,
        orchestrationStatus: TaskOrchestrationStatus.ASSIGNED,
      });

      const readinessResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${dependent.id}/readiness`,
      });
      expect(readinessResponse.json()).toMatchObject({ ready: false });

      for (const status of [
        TaskOrchestrationStatus.RUNNING,
        TaskOrchestrationStatus.REVIEW,
        TaskOrchestrationStatus.DONE,
      ]) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/tasks/${prerequisite.id}/orchestration`,
          payload: {
            status,
            ...(status !== TaskOrchestrationStatus.DONE ? { workerId: 'route-worker' } : {}),
          },
        });
        expect(response.statusCode).toBe(200);
      }

      await expect(app.inject({
        method: 'POST',
        url: `/api/tasks/${dependent.id}/orchestration/ready`,
      })).resolves.toMatchObject({ statusCode: 200 });

      const dependentClaim = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks/claim-next`,
        payload: { workerId: 'route-worker-2' },
      });
      expect(dependentClaim.json()).toMatchObject({
        id: dependent.id,
        orchestrationStatus: TaskOrchestrationStatus.ASSIGNED,
      });

      const eventsResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${dependent.id}/events`,
      });
      expect(eventsResponse.statusCode).toBe(200);
      expect(eventsResponse.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'task.dependency_added' }),
        expect.objectContaining({ type: 'task.claimed' }),
      ]));
    } finally {
      await app.close();
    }
  });

  it('exposes idempotent generic workflow DAG endpoints', async () => {
    const project = await prisma.project.create({
      data: { name: 'Workflow route project', repoPath: testDir },
    });
    const root = await prisma.task.create({
      data: { title: 'Root workflow task', projectId: project.id },
    });
    const app = Fastify();
    await app.register(taskRoutes, { prefix: '/api' });

    try {
      const payload = {
        runId: 'generic-001',
        nodes: [
          { key: 'inspect', title: 'Inspect', role: 'Reader' },
          { key: 'write', title: 'Write', role: 'Writer', dependsOnKeys: ['inspect'] },
        ],
      };
      const created = await app.inject({
        method: 'POST',
        url: `/api/tasks/${root.id}/workflows`,
        payload,
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ runId: 'generic-001' });

      const repeated = await app.inject({
        method: 'POST',
        url: `/api/tasks/${root.id}/workflows`,
        payload,
      });
      expect(repeated.statusCode).toBe(201);
      expect(repeated.json().nodes.map((node: any) => node.task.id))
        .toEqual(created.json().nodes.map((node: any) => node.task.id));

      const listed = await app.inject({
        method: 'GET',
        url: `/api/tasks/${root.id}/workflows`,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().workflows).toHaveLength(1);
      expect(listed.json().workflows[0].edges).toEqual([
        { taskKey: 'write', dependsOnKey: 'inspect' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('exposes structured human-input request and answer endpoints', async () => {
    const project = await prisma.project.create({
      data: { name: 'Human input route project', repoPath: testDir },
    });
    const root = await prisma.task.create({
      data: { title: 'Root workflow task', projectId: project.id },
    });
    const app = Fastify();
    await app.register(taskRoutes, { prefix: '/api' });

    try {
      const created = await app.inject({
        method: 'POST',
        url: `/api/tasks/${root.id}/workflows`,
        payload: {
          runId: 'human-route-001',
          nodes: [{ key: 'scope', title: 'Resolve source root', role: 'Analyst' }],
        },
      });
      const node = created.json().nodes[0];

      await app.inject({
        method: 'POST',
        url: `/api/tasks/${node.task.id}/orchestration/claim`,
        payload: { workerId: 'analyst-a' },
      });
      await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${node.task.id}/orchestration`,
        payload: { status: TaskOrchestrationStatus.RUNNING, workerId: 'analyst-a' },
      });

      const directTransition = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${node.task.id}/orchestration`,
        payload: { status: TaskOrchestrationStatus.WAITING_INPUT, workerId: 'analyst-a' },
      });
      expect(directTransition.statusCode).toBe(400);

      const requested = await app.inject({
        method: 'POST',
        url: `/api/tasks/${root.id}/workflows/human-route-001/nodes/${node.task.id}/human-input`,
        payload: {
          requestKey: 'source-root',
          question: 'Which source root should be analyzed?',
          options: ['service-a', 'service-b'],
          allowFreeText: false,
          workerId: 'analyst-a',
        },
      });
      expect(requested.statusCode).toBe(200);
      expect(requested.json()).toMatchObject({
        humanInput: { status: 'WAITING' },
        task: { orchestrationStatus: TaskOrchestrationStatus.WAITING_INPUT },
      });

      const answered = await app.inject({
        method: 'POST',
        url: `/api/tasks/${root.id}/workflows/human-route-001/nodes/${node.task.id}/human-input/${requested.json().humanInput.questionId}/answer`,
        payload: { answer: 'service-a', actorType: 'USER' },
      });
      expect(answered.statusCode).toBe(200);
      expect(answered.json()).toMatchObject({
        resumed: true,
        humanInput: { status: 'ANSWERED', answer: 'service-a' },
        task: { orchestrationStatus: TaskOrchestrationStatus.READY },
      });
    } finally {
      await app.close();
    }
  });
});
