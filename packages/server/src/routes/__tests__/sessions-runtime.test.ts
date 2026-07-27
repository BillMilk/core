import Fastify from 'fastify';
import { AgentType, RuntimeType } from '@agent-tower/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors.js';

const { findWorkspace, findSession, createSession, getRuntimeState, resolveRuntimePermission, getProviderById } = vi.hoisted(() => ({
  findWorkspace: vi.fn(),
  findSession: vi.fn(),
  createSession: vi.fn(),
  getRuntimeState: vi.fn(),
  resolveRuntimePermission: vi.fn(),
  getProviderById: vi.fn(),
}));

vi.mock('../../core/container.js', () => ({
  getSessionManager: () => ({
    create: createSession,
    getRuntimeState,
    resolveRuntimePermission,
  }),
}));

vi.mock('../../utils/index.js', () => ({
  prisma: {
    workspace: { findUnique: findWorkspace },
    session: { findUnique: findSession },
  },
}));

vi.mock('../../executors/index.js', () => ({ getProviderById }));

import { sessionRoutes } from '../sessions.js';

async function buildTestApp() {
  const app = Fastify();
  await app.register(sessionRoutes, { prefix: '/api' });
  return app;
}

describe('session runtime routes', () => {
  beforeEach(() => {
    findWorkspace.mockReset();
    findSession.mockReset();
    createSession.mockReset();
    getRuntimeState.mockReset();
    resolveRuntimePermission.mockReset();
    getProviderById.mockReset();
  });

  it('maps an unsupported Agent runtime combination to a validation response', async () => {
    const app = await buildTestApp();
    findWorkspace.mockResolvedValue({
      id: 'workspace-1',
      task: {
        deletedAt: null,
        project: { name: 'Project', archivedAt: null, repoDeletedAt: null },
      },
    });
    createSession.mockRejectedValue(
      new ValidationError("Agent 'QWEN_CODE' does not support the 'CLI' runtime"),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/sessions',
      payload: { agentType: AgentType.QWEN_CODE, prompt: 'run qwen' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Agent 'QWEN_CODE' does not support the 'CLI' runtime",
      code: 'VALIDATION_ERROR',
    });
    await app.close();
  });

  it('returns the authoritative runtime state using the persisted runtime type', async () => {
    const app = await buildTestApp();
    findSession.mockResolvedValue({ id: 'session-1', runtimeType: RuntimeType.ACP });
    getRuntimeState.mockReturnValue({
      sessionId: 'session-1',
      runtimeType: RuntimeType.ACP,
      turnState: 'AWAITING_PERMISSION',
      capabilities: { loadSession: true, terminalInput: false, terminalResize: false, permissions: true },
      pendingPermissions: [],
    });

    const response = await app.inject({ method: 'GET', url: '/api/sessions/session-1/runtime' });

    expect(response.statusCode).toBe(200);
    expect(getRuntimeState).toHaveBeenCalledWith('session-1', RuntimeType.ACP);
    expect(response.json()).toMatchObject({ runtimeType: RuntimeType.ACP, turnState: 'AWAITING_PERMISSION' });
    await app.close();
  });

  it('resolves only a currently active permission decision', async () => {
    const app = await buildTestApp();
    findSession.mockResolvedValue({ id: 'session-1' });
    resolveRuntimePermission.mockResolvedValue(undefined);

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/permissions/permission-1/resolve',
      payload: { optionId: 'allow-once' },
    });

    expect(response.statusCode).toBe(200);
    expect(resolveRuntimePermission).toHaveBeenCalledWith('session-1', 'permission-1', 'allow-once');
    await app.close();
  });

  it('returns conflict when a permission request is stale', async () => {
    const app = await buildTestApp();
    findSession.mockResolvedValue({ id: 'session-1' });
    resolveRuntimePermission.mockRejectedValue(new Error('Permission request is no longer active'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/permissions/permission-1/resolve',
      payload: { optionId: 'allow-once' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Permission request is no longer active' });
    await app.close();
  });
});
