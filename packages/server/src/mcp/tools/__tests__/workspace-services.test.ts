import { describe, expect, it, vi } from 'vitest';
import { AgentTowerApiError } from '../../http-client.js';
import { registerWorkspaceServiceTools } from '../workspace-services.js';

function createServerMock() {
  const handlers = new Map<string, (params: any) => Promise<any>>();
  return {
    handlers,
    server: {
      tool: vi.fn((name: string, _description: string, _shape: unknown, handler: (params: any) => Promise<any>) => {
        handlers.set(name, handler);
      }),
    },
  };
}

describe('workspace service MCP tools', () => {
  it('registers exactly five tools only in workspace context and binds all calls to it', async () => {
    const withoutContext = createServerMock();
    registerWorkspaceServiceTools(withoutContext.server as any, {} as any, null);
    expect(withoutContext.handlers.size).toBe(0);

    const { server, handlers } = createServerMock();
    const client = {
      startWorkspaceService: vi.fn(async () => ({ id: 'service-1' })),
      listWorkspaceServices: vi.fn(),
      getWorkspaceServiceLogs: vi.fn(async () => ({ entries: [] })),
      sendWorkspaceServiceInput: vi.fn(),
      controlWorkspaceService: vi.fn(),
    };
    const auth = {
      resolveBoundTeamRunId: vi.fn(() => 'team-run-1'),
      requireCurrentMemberCapabilities: vi.fn(async () => 'member-1'),
    };
    registerWorkspaceServiceTools(server as any, client as any, {
      workspaceId: 'workspace-1',
      teamRunId: 'team-run-1',
    } as any, auth);

    expect([...handlers.keys()]).toEqual([
      'start_workspace_service',
      'list_workspace_services',
      'get_workspace_service_logs',
      'send_workspace_service_input',
      'control_workspace_service',
    ]);
    await handlers.get('start_workspace_service')!({
      service_name: 'web',
      command: 'pnpm',
      args: ['dev'],
      relative_cwd: 'packages/web',
    });
    expect(auth.requireCurrentMemberCapabilities).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ workspaceId: 'workspace-1' }),
      'team-run-1',
      ['runCommands'],
    );
    expect(client.startWorkspaceService).toHaveBeenCalledWith('workspace-1', 'web', {
      command: 'pnpm',
      args: ['dev'],
      relativeCwd: 'packages/web',
    });

    await handlers.get('get_workspace_service_logs')!({
      service_name: 'web',
      runtime_instance_id: 'runtime-1',
      after_seq: 4,
      limit: 20,
    });
    expect(client.getWorkspaceServiceLogs).toHaveBeenCalledWith('workspace-1', 'web', {
      runtimeInstanceId: 'runtime-1',
      afterSeq: 4,
      limit: 20,
    });
  });

  it('preserves REST status and error code in MCP errors', async () => {
    const { server, handlers } = createServerMock();
    const client = {
      listWorkspaceServices: vi.fn(async () => {
        throw new AgentTowerApiError(403, 'INVOCATION_WORKSPACE_MISMATCH', 'wrong workspace');
      }),
    };
    registerWorkspaceServiceTools(server as any, client as any, { workspaceId: 'workspace-1' } as any);

    const result = await handlers.get('list_workspace_services')!({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'wrong workspace',
      code: 'INVOCATION_WORKSPACE_MISMATCH',
      status: 403,
    });
  });
});
