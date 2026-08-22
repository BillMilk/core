import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { TaskService } from '../services/task.service.js';
import { TaskStatus } from '../types/index.js';
import { TaskOrchestrationStatus } from '@agent-tower/shared';
import { ServiceError } from '../errors.js';
import {
  getEventBus,
  getSessionManager,
  getTaskCleanupService,
  getTaskOrchestrationService,
  getWorkspaceBackgroundService,
} from '../core/container.js';

const createTaskSchema = z.object({
  title: z.string().min(1, 'title is required').refine((value) => value.trim().length > 0, 'title is required'),
  description: z.string().optional(),
  priority: z.number().int().min(0).default(0),
});

const updateTaskSchema = z.object({
  title: z.string().min(1, 'title cannot be empty').refine((value) => value.trim().length > 0, 'title cannot be empty').optional(),
  description: z.string().optional(),
  priority: z.number().int().min(0).optional(),
});

const updateStatusSchema = z.object({
  status: z.nativeEnum(TaskStatus, {
    errorMap: () => ({
      message: `status must be one of: ${Object.values(TaskStatus).join(', ')}`,
    }),
  }),
});

const updatePositionSchema = z.object({
  position: z.number().int().min(0, 'position must be non-negative'),
  status: z.nativeEnum(TaskStatus).optional(),
});

const taskListQuerySchema = z.object({
  status: z.nativeEnum(TaskStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

const taskBoardQuerySchema = taskListQuerySchema.extend({
  projectId: z.string().uuid().optional(),
}).extend({
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
});

const addDependencySchema = z.object({
  dependsOnTaskId: z.string().uuid('dependsOnTaskId must be a valid task id'),
});

const orchestrationWorkerSchema = z.object({
  workerId: z.string().min(1, 'workerId is required').max(200),
});

const orchestrationTransitionSchema = z.object({
  status: z.nativeEnum(TaskOrchestrationStatus),
  workerId: z.string().min(1).max(200).optional(),
  actorType: z.string().min(1).max(100).optional(),
  actorId: z.string().min(1).max(200).optional(),
  reason: z.string().max(2_000).optional(),
}).refine((value) => value.status !== TaskOrchestrationStatus.WAITING_INPUT, {
  path: ['status'],
  message: 'WAITING_INPUT requires the structured human-input endpoint',
});

const taskEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  after: z.string().datetime().optional(),
});

const workflowRunIdSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/);
const workflowNodeSchema = z.object({
  key: z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/),
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).optional(),
  role: z.string().min(1).max(200),
  promptFile: z.string().max(1_000).optional(),
  outputPaths: z.array(z.string().min(1).max(1_000)).max(100).optional(),
  verifyId: z.string().max(200).optional(),
  dependsOnKeys: z.array(z.string().min(1).max(120)).max(100).optional(),
  priority: z.number().int().min(0).max(100).optional(),
});
const workflowMutationSchema = z.object({
  runId: workflowRunIdSchema,
  nodes: z.array(workflowNodeSchema).min(1).max(500),
});
const workflowCompleteSchema = z.object({
  actorType: z.string().min(1).max(100).optional(),
  actorId: z.string().min(1).max(200).optional(),
  reason: z.string().max(2_000).optional(),
});
const workflowHumanInputRequestSchema = z.object({
  requestKey: z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/),
  question: z.string().min(1).max(4_000),
  context: z.string().max(8_000).optional(),
  options: z.array(z.string().min(1).max(1_000)).max(20).optional(),
  allowFreeText: z.boolean().optional(),
  workerId: z.string().min(1).max(200).optional(),
  actorType: z.string().min(1).max(100).optional(),
  actorId: z.string().min(1).max(200).optional(),
});
const workflowHumanInputAnswerSchema = z.object({
  answer: z.string().min(1).max(20_000),
  actorType: z.string().min(1).max(100).optional(),
  actorId: z.string().min(1).max(200).optional(),
});

/**
 * 统一错误处理：将 ServiceError / ZodError 转为结构化响应
 */
function handleError(error: unknown, reply: any) {
  if (error instanceof ZodError) {
    const fieldErrors = error.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    reply.code(400);
    return { error: 'Validation failed', code: 'VALIDATION_ERROR', details: fieldErrors };
  }

  if (error instanceof ServiceError) {
    reply.code(error.statusCode);
    return { error: error.message, code: error.code };
  }

  console.error('[tasks] Unhandled error:', error);
  reply.code(500);
  return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
}

export async function taskRoutes(app: FastifyInstance) {
  const taskService = new TaskService(
    getEventBus(),
    getSessionManager(),
    getTaskCleanupService(),
    getWorkspaceBackgroundService(),
  );
  const orchestrationService = getTaskOrchestrationService();

  app.get('/task-board', async (request, reply) => {
    try {
      const query = taskBoardQuerySchema.parse(request.query);
      return await taskService.findBoard(query);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // 获取项目的任务列表（支持分页和状态过滤）
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks',
    async (request, reply) => {
      try {
        const query = taskListQuerySchema.parse(request.query);
        return await taskService.findByProjectId(request.params.projectId, query);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks/ready',
    async (request, reply) => {
      try {
        const query = z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }).parse(request.query);
        return await orchestrationService.listReadyTasks(request.params.projectId, query.limit);
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks/claim-next',
    async (request, reply) => {
      try {
        const body = orchestrationWorkerSchema.parse(request.body);
        return await orchestrationService.claimNext(body.workerId, request.params.projectId);
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // 创建任务
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks',
    async (request, reply) => {
      try {
        const body = createTaskSchema.parse(request.body);
        const task = await taskService.create(request.params.projectId, body);
        reply.code(201);
        return task;
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // 获取项目的任务统计
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks/stats',
    async (request, reply) => {
      try {
        return await taskService.getStatsByProjectId(request.params.projectId);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // 获取任务详情
  app.get<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
    try {
      return await taskService.findById(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/tasks/:id/body', async (request, reply) => {
    try {
      return await taskService.findBodyById(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/tasks/:id/dependencies', async (request, reply) => {
    try {
      return await orchestrationService.listDependencies(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/dependencies', async (request, reply) => {
    try {
      const body = addDependencySchema.parse(request.body);
      const dependency = await orchestrationService.addDependency(
        request.params.id,
        body.dependsOnTaskId,
      );
      reply.code(201);
      return dependency;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.delete<{ Params: { id: string; dependsOnTaskId: string } }>(
    '/tasks/:id/dependencies/:dependsOnTaskId',
    async (request, reply) => {
      try {
        await orchestrationService.removeDependency(
          request.params.id,
          request.params.dependsOnTaskId,
        );
        reply.code(204);
        return;
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get<{ Params: { id: string } }>('/tasks/:id/readiness', async (request, reply) => {
    try {
      return await orchestrationService.getReadiness(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/tasks/:id/events', async (request, reply) => {
    try {
      const query = taskEventsQuerySchema.parse(request.query);
      return await orchestrationService.listEvents(request.params.id, {
        limit: query.limit,
        after: query.after ? new Date(query.after) : undefined,
      });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post<{ Params: { rootTaskId: string } }>(
    '/tasks/:rootTaskId/workflows',
    async (request, reply) => {
      try {
        const body = workflowMutationSchema.parse(request.body);
        const dag = await orchestrationService.createWorkflowDag(request.params.rootTaskId, body);
        reply.code(201);
        return dag;
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get<{ Params: { rootTaskId: string } }>(
    '/tasks/:rootTaskId/workflows',
    async (request, reply) => {
      try {
        return {
          rootTaskId: request.params.rootTaskId,
          workflows: await orchestrationService.listTaskWorkflows(request.params.rootTaskId),
        };
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Params: { rootTaskId: string; runId: string } }>(
    '/tasks/:rootTaskId/workflows/:runId/nodes',
    async (request, reply) => {
      try {
        const runId = workflowRunIdSchema.parse(request.params.runId);
        const body = z.object({ nodes: z.array(workflowNodeSchema).min(1).max(500) }).parse(request.body);
        const dag = await orchestrationService.createWorkflowDag(request.params.rootTaskId, {
          runId,
          nodes: body.nodes,
        });
        reply.code(201);
        return dag;
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get<{ Params: { rootTaskId: string; runId: string } }>(
    '/tasks/:rootTaskId/workflows/:runId',
    async (request, reply) => {
      try {
        const runId = workflowRunIdSchema.parse(request.params.runId);
        return await orchestrationService.getWorkflowDag(request.params.rootTaskId, runId);
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Params: { rootTaskId: string; runId: string; taskId: string } }>(
    '/tasks/:rootTaskId/workflows/:runId/nodes/:taskId/complete',
    async (request, reply) => {
      try {
        const runId = workflowRunIdSchema.parse(request.params.runId);
        const body = workflowCompleteSchema.parse(request.body ?? {});
        return await orchestrationService.completeWorkflowTask(
          request.params.rootTaskId,
          runId,
          request.params.taskId,
          body,
        );
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Params: { rootTaskId: string; runId: string; taskId: string } }>(
    '/tasks/:rootTaskId/workflows/:runId/nodes/:taskId/human-input',
    async (request, reply) => {
      try {
        const runId = workflowRunIdSchema.parse(request.params.runId);
        const body = workflowHumanInputRequestSchema.parse(request.body);
        return await orchestrationService.requestHumanInput(
          request.params.rootTaskId,
          runId,
          request.params.taskId,
          {
            requestKey: body.requestKey,
            question: body.question,
            context: body.context,
            options: body.options,
            allowFreeText: body.allowFreeText,
          },
          body,
        );
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Params: { rootTaskId: string; runId: string; taskId: string; questionId: string } }>(
    '/tasks/:rootTaskId/workflows/:runId/nodes/:taskId/human-input/:questionId/answer',
    async (request, reply) => {
      try {
        const runId = workflowRunIdSchema.parse(request.params.runId);
        const body = workflowHumanInputAnswerSchema.parse(request.body);
        return await orchestrationService.answerHumanInput(
          request.params.rootTaskId,
          runId,
          request.params.taskId,
          request.params.questionId,
          body.answer,
          body,
        );
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/tasks/:id/orchestration/ready', async (request, reply) => {
    try {
      return await orchestrationService.markReady(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/orchestration/claim', async (request, reply) => {
    try {
      const body = orchestrationWorkerSchema.parse(request.body);
      return await orchestrationService.claim(request.params.id, body.workerId);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/orchestration/heartbeat', async (request, reply) => {
    try {
      const body = orchestrationWorkerSchema.parse(request.body);
      return await orchestrationService.heartbeat(request.params.id, body.workerId);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.patch<{ Params: { id: string } }>('/tasks/:id/orchestration', async (request, reply) => {
    try {
      const body = orchestrationTransitionSchema.parse(request.body);
      return await orchestrationService.transition(request.params.id, body.status, body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // 更新任务
  app.put<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
    try {
      const body = updateTaskSchema.parse(request.body);
      return await taskService.update(request.params.id, body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // 更新任务状态（含状态流转校验）
  app.patch<{ Params: { id: string } }>(
    '/tasks/:id/status',
    async (request, reply) => {
      try {
        const body = updateStatusSchema.parse(request.body);
        return await taskService.updateStatus(request.params.id, body.status);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // 更新任务位置
  app.patch<{ Params: { id: string } }>(
    '/tasks/:id/position',
    async (request, reply) => {
      try {
        const body = updatePositionSchema.parse(request.body);
        return await taskService.updatePosition(
          request.params.id,
          body.position,
          body.status
        );
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // 删除任务
  app.delete<{ Params: { id: string } }>(
    '/tasks/:id',
    async (request, reply) => {
      try {
        await taskService.delete(request.params.id);
        reply.code(204);
        return;
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // 重试任务（归档当前 Workspace，重置状态为 TODO）
  app.post<{ Params: { id: string } }>(
    '/tasks/:id/retry',
    async (request, reply) => {
      try {
        return await taskService.retry(request.params.id);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );
}
