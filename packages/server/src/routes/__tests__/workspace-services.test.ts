import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ServiceError } from '../../errors.js';
import { workspaceServiceRoutes } from '../workspace-services.js';

function createService() {
  return {
    authorizeCaller: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    start: vi.fn(async () => ({ id: 'service-1', runtimeState: 'RUNNING' })),
    getLogs: vi.fn(async () => ({ entries: [] })),
    sendInput: vi.fn(async () => ({ accepted: true })),
    stop: vi.fn(async () => ({ runtimeState: 'STOPPED' })),
    restart: vi.fn(async () => ({ runtimeState: 'RUNNING' })),
  };
}

async function buildApp(
  service: ReturnType<typeof createService>,
  authKind?: 'unauthenticated' | 'browser' | 'agent' | 'internal',
) {
  const app = Fastify();
  if (authKind) {
    app.addHook('onRequest', async (request) => {
      request.agentTowerAuthKind = authKind;
      if (authKind === 'agent') {
        request.agentTowerAgentIdentity = {
          sessionId: 'session-1',
          invocationId: 'invocation-1',
        };
      }
    });
  }
  await app.register(workspaceServiceRoutes, { backgroundService: service as any });
  return app;
}

describe('workspace service routes', () => {
  it('authorizes the invocation and starts a structured command', async () => {
    const service = createService();
    const app = await buildApp(service, 'agent');
    const response = await app.inject({
      method: 'PUT',
      url: '/workspaces/workspace-1/services/web',
      payload: { command: 'pnpm', args: ['dev'], relativeCwd: 'packages/web' },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(service.authorizeCaller).toHaveBeenCalledWith('workspace-1', {
      kind: 'agent',
      sessionId: 'session-1',
      invocationId: 'invocation-1',
    });
    expect(service.start).toHaveBeenCalledWith('workspace-1', 'web', {
      command: 'pnpm',
      args: ['dev'],
      relativeCwd: 'packages/web',
    });
  });

  it('rejects env and preserves stable service error codes', async () => {
    const service = createService();
    const app = await buildApp(service, 'agent');
    const invalid = await app.inject({
      method: 'PUT',
      url: '/workspaces/workspace-1/services/web',
      payload: { command: 'pnpm', env: { SECRET: 'value' } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.start).not.toHaveBeenCalled();

    service.authorizeCaller.mockRejectedValueOnce(
      new ServiceError('wrong workspace', 'INVOCATION_WORKSPACE_MISMATCH', 403),
    );
    const forbidden = await app.inject({
      method: 'GET',
      url: '/workspaces/workspace-1/services',
      headers: { 'x-agent-tower-invocation-id': 'invocation-2' },
    });
    await app.close();
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({
      error: 'wrong workspace',
      code: 'INVOCATION_WORKSPACE_MISMATCH',
    });
  });

  it('allows browser callers to list services and read logs without trusting identity headers', async () => {
    const service = createService();
    const app = await buildApp(service, 'browser');
    const listResponse = await app.inject({
      method: 'GET',
      url: '/workspaces/workspace-1/services',
      headers: {
        'x-agent-tower-session-id': 'spoofed-session',
        'x-agent-tower-invocation-id': 'spoofed-invocation',
      },
    });
    const logsResponse = await app.inject({
      method: 'GET',
      url: '/workspaces/workspace-1/services/web/logs?afterSeq=4&runtimeInstanceId=runtime-1&limit=20',
      headers: {
        'x-agent-tower-session-id': 'spoofed-session',
        'x-agent-tower-invocation-id': 'spoofed-invocation',
      },
    });
    await app.close();

    expect(listResponse.statusCode).toBe(200);
    expect(logsResponse.statusCode).toBe(200);
    expect(service.authorizeCaller).toHaveBeenNthCalledWith(1, 'workspace-1', { kind: 'browser' }, 'read');
    expect(service.authorizeCaller).toHaveBeenNthCalledWith(2, 'workspace-1', { kind: 'browser' }, 'read');
    expect(service.getLogs).toHaveBeenCalledWith('workspace-1', 'web', {
      afterSeq: 4,
      runtimeInstanceId: 'runtime-1',
      limit: 20,
    });
  });

  it('rejects every browser control route before accepting spoofed internal identity', async () => {
    const service = createService();
    const app = await buildApp(service, 'browser');
    const requests = [
      { method: 'PUT' as const, url: '/workspaces/workspace-1/services/web', payload: {} },
      { method: 'POST' as const, url: '/workspaces/workspace-1/services/web/input', payload: {} },
      { method: 'POST' as const, url: '/workspaces/workspace-1/services/web/stop' },
      { method: 'POST' as const, url: '/workspaces/workspace-1/services/web/restart' },
    ];

    for (const request of requests) {
      const response = await app.inject({
        ...request,
        headers: {
          'x-agent-tower-session-id': 'spoofed-session',
          'x-agent-tower-invocation-id': 'spoofed-invocation',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'WORKSPACE_SERVICE_BROWSER_UNAVAILABLE' });
    }
    await app.close();

    expect(service.authorizeCaller).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect(service.sendInput).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it('rejects callers without Agent authentication', async () => {
    const service = createService();
    const app = await buildApp(service, 'unauthenticated');
    const response = await app.inject({
      method: 'GET',
      url: '/workspaces/workspace-1/services',
    });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'WORKSPACE_SERVICE_AUTH_REQUIRED' });
    expect(service.authorizeCaller).not.toHaveBeenCalled();
  });
});
