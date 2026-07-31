import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { getWorkspaceBackgroundService } from '../core/container.js';
import { ServiceError } from '../errors.js';
import type { WorkspaceBackgroundService } from '../services/workspace-background-service.service.js';
import {
  INTERNAL_API_INVOCATION_ID_HEADER,
  INTERNAL_API_SESSION_ID_HEADER,
} from '../utils/internal-api-token.js';

const serviceParamsSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1),
});

const workspaceParamsSchema = z.object({ workspaceId: z.string().min(1) });

const startSchema = z.object({
  command: z.string().min(1).max(512),
  args: z.array(z.string().max(8_192)).max(100).optional(),
  relativeCwd: z.string().max(1_024).optional(),
}).strict();

const logsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  runtimeInstanceId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const inputSchema = z.object({ data: z.string().min(1) }).strict();

export interface WorkspaceServiceRoutesOptions {
  backgroundService?: WorkspaceBackgroundService;
}

function getHeader(headers: Record<string, unknown>, name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getCaller(request: {
  agentTowerAuthKind?: 'unauthenticated' | 'browser' | 'agent' | 'internal';
  agentTowerAgentIdentity?: { sessionId: string; invocationId: string | null };
  headers: Record<string, unknown>;
}, access: 'read' | 'control' = 'control') {
  if (request.agentTowerAuthKind === 'browser') {
    if (access === 'read') return { kind: 'browser' as const };
    throw new ServiceError(
      'Browser control of workspace services is not available',
      'WORKSPACE_SERVICE_BROWSER_UNAVAILABLE',
      403,
    );
  }
  if (request.agentTowerAuthKind === 'agent' && request.agentTowerAgentIdentity) {
    return {
      kind: 'agent' as const,
      sessionId: request.agentTowerAgentIdentity.sessionId,
      invocationId: request.agentTowerAgentIdentity.invocationId,
    };
  }
  if (request.agentTowerAuthKind !== 'internal') {
    throw new ServiceError(
      'Workspace service access requires Agent authentication',
      'WORKSPACE_SERVICE_AUTH_REQUIRED',
      401,
    );
  }
  return {
    kind: 'internal' as const,
    sessionId: getHeader(request.headers, INTERNAL_API_SESSION_ID_HEADER),
    invocationId: getHeader(request.headers, INTERNAL_API_INVOCATION_ID_HEADER),
  };
}

function handleError(error: unknown, reply: { code(statusCode: number): unknown }) {
  if (error instanceof ZodError) {
    reply.code(400);
    return { error: 'Validation failed', code: 'VALIDATION_ERROR' };
  }
  if (error instanceof ServiceError) {
    reply.code(error.statusCode);
    return { error: error.message, code: error.code };
  }
  reply.code(500);
  return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
}

export async function workspaceServiceRoutes(
  app: FastifyInstance,
  options: WorkspaceServiceRoutesOptions = {},
) {
  const service = options.backgroundService ?? getWorkspaceBackgroundService();

  app.get('/workspaces/:workspaceId/services', async (request, reply) => {
    try {
      const { workspaceId } = workspaceParamsSchema.parse(request.params);
      await service.authorizeCaller(workspaceId, getCaller(request, 'read'), 'read');
      return { services: await service.list(workspaceId) };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.put('/workspaces/:workspaceId/services/:name', async (request, reply) => {
    try {
      const caller = getCaller(request);
      const { workspaceId, name } = serviceParamsSchema.parse(request.params);
      const body = startSchema.parse(request.body);
      await service.authorizeCaller(workspaceId, caller);
      return await service.start(workspaceId, name, body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get('/workspaces/:workspaceId/services/:name/logs', async (request, reply) => {
    try {
      const { workspaceId, name } = serviceParamsSchema.parse(request.params);
      const query = logsQuerySchema.parse(request.query);
      await service.authorizeCaller(workspaceId, getCaller(request, 'read'), 'read');
      return await service.getLogs(workspaceId, name, query);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post('/workspaces/:workspaceId/services/:name/input', async (request, reply) => {
    try {
      const caller = getCaller(request);
      const { workspaceId, name } = serviceParamsSchema.parse(request.params);
      const { data } = inputSchema.parse(request.body);
      await service.authorizeCaller(workspaceId, caller);
      return await service.sendInput(workspaceId, name, data);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post('/workspaces/:workspaceId/services/:name/stop', async (request, reply) => {
    try {
      const caller = getCaller(request);
      const { workspaceId, name } = serviceParamsSchema.parse(request.params);
      await service.authorizeCaller(workspaceId, caller);
      return await service.stop(workspaceId, name);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post('/workspaces/:workspaceId/services/:name/restart', async (request, reply) => {
    try {
      const caller = getCaller(request);
      const { workspaceId, name } = serviceParamsSchema.parse(request.params);
      await service.authorizeCaller(workspaceId, caller);
      return await service.restart(workspaceId, name);
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
