import { TaskOrchestrationStatus } from '@agent-tower/shared';
import { describe, expect, it, vi } from 'vitest';
import { registerTaskWorkflowTools } from '../task-workflows.js';

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

function workflowDag(overrides: Record<string, unknown> = {}) {
  return {
    rootTaskId: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    runId: 'docs-1',
    nodes: [{
      key: 'discover',
      role: 'Analyst',
      outputPaths: [],
      dependsOnKeys: [],
      task: {
        id: '00000000-0000-4000-8000-000000000003',
        projectId: '00000000-0000-4000-8000-000000000002',
        title: '[Workflow:docs-1] discover Discover',
        status: 'TODO',
        orchestrationStatus: TaskOrchestrationStatus.READY,
        orchestrationClaimedBy: null,
        orchestrationClaimedAt: null,
        orchestrationHeartbeatAt: null,
        orchestrationAttemptCount: 0,
        orchestrationLastError: null,
        priority: 0,
        ...overrides,
      },
    }],
    edges: [],
    counts: { READY: 1 },
  };
}

function identityClient(member: Record<string, unknown>, extra: Record<string, unknown> = {}): any {
  return {
    getTeamRun: vi.fn(async () => ({
      taskId: '00000000-0000-4000-8000-000000000001',
      mainWorkspaceId: 'workspace-1',
      task: { projectId: '00000000-0000-4000-8000-000000000002' },
    })),
    listTeamMembers: vi.fn(async () => [member]),
    ...extra,
  };
}

const auth = {
  resolveBoundTeamRunId: vi.fn(() => 'team-run-1'),
  requireCurrentActiveTeamMember: vi.fn(async () => 'member-1'),
};

describe('task workflow MCP tools', () => {
  it('creates a generic DAG only for the queue manager and maps snake_case inputs', async () => {
    const { server, handlers } = createServerMock();
    const client = identityClient({
      id: 'member-1',
      name: 'Controller',
      aliases: [],
      queueManagementPolicy: 'team_pending',
    }, {
      createTaskWorkflow: vi.fn(async () => workflowDag()),
    });
    registerTaskWorkflowTools(server as any, client as any, { teamRunId: 'team-run-1' } as any, auth);

    const result = await handlers.get('create_task_dag')!({
      run_id: 'docs-1',
      nodes: [{
        key: 'discover',
        title: 'Discover',
        role: 'Analyst',
        output_paths: ['out/findings.md'],
        depends_on_keys: [],
      }],
    });

    expect(result.isError).toBeUndefined();
    expect(client.createTaskWorkflow).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      expect.objectContaining({
        runId: 'docs-1',
        nodes: [expect.objectContaining({ role: 'Analyst', outputPaths: ['out/findings.md'] })],
      }),
    );
  });

  it('rejects manager operations for ordinary members', async () => {
    const { server, handlers } = createServerMock();
    const client = identityClient({
      id: 'member-1',
      name: 'Analyst',
      aliases: [],
      queueManagementPolicy: 'own_only',
    }, {
      createTaskWorkflow: vi.fn(),
    });
    registerTaskWorkflowTools(server as any, client as any, { teamRunId: 'team-run-1' } as any, auth);

    const result = await handlers.get('create_task_dag')!({
      run_id: 'docs-1',
      nodes: [{ key: 'discover', title: 'Discover', role: 'Analyst' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('queue manager');
    expect(client.createTaskWorkflow).not.toHaveBeenCalled();
  });

  it('infers worker identity and enforces the workflow node role', async () => {
    const { server, handlers } = createServerMock();
    const client = identityClient({
      id: 'member-1',
      name: 'Analyst',
      aliases: ['code-reader'],
      queueManagementPolicy: 'own_only',
    }, {
      getTaskWorkflow: vi.fn(async () => workflowDag()),
      claimTask: vi.fn(async () => ({ id: '00000000-0000-4000-8000-000000000003' })),
    });
    registerTaskWorkflowTools(server as any, client as any, { teamRunId: 'team-run-1' } as any, auth);

    const result = await handlers.get('claim_task_node')!({
      run_id: 'docs-1',
      task_id: '00000000-0000-4000-8000-000000000003',
    });

    expect(result.isError).toBeUndefined();
    expect(client.claimTask).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000003',
      'member-1',
    );
  });

  it('creates a durable human-input gate with inferred member identity', async () => {
    const { server, handlers } = createServerMock();
    const taskId = '00000000-0000-4000-8000-000000000003';
    const client = identityClient({
      id: 'member-1',
      name: 'Analyst',
      aliases: [],
      queueManagementPolicy: 'own_only',
    }, {
      getTaskWorkflow: vi.fn(async () => workflowDag({
        orchestrationStatus: TaskOrchestrationStatus.RUNNING,
        orchestrationClaimedBy: 'member-1',
      })),
      requestTaskWorkflowHumanInput: vi.fn(async () => ({
        humanInput: { questionId: '10000000-0000-4000-8000-000000000001' },
        task: { orchestrationStatus: TaskOrchestrationStatus.WAITING_INPUT },
      })),
      createRoomMessage: vi.fn(async () => ({ id: 'message-1' })),
    });
    registerTaskWorkflowTools(server as any, client as any, {
      teamRunId: 'team-run-1',
      invocationId: 'invocation-1',
    } as any, auth);

    const result = await handlers.get('request_human_input')!({
      run_id: 'docs-1',
      task_id: taskId,
      request_key: 'scope-choice',
      question: 'Which scope should be used?',
      options: ['full', 'partial'],
      allow_free_text: false,
    });

    expect(result.isError).toBeUndefined();
    expect(client.requestTaskWorkflowHumanInput).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'docs-1',
      taskId,
      expect.objectContaining({ workerId: 'member-1', actorId: 'member-1' }),
    );
    expect(client.createRoomMessage).toHaveBeenCalledWith(
      'team-run-1',
      expect.objectContaining({ senderType: 'agent', senderId: 'member-1', kind: 'decision' }),
    );
  });

  it('allows only the queue manager to resolve an explicit human answer', async () => {
    const { server, handlers } = createServerMock();
    const taskId = '00000000-0000-4000-8000-000000000003';
    const client = identityClient({
      id: 'member-1',
      name: 'Controller',
      aliases: [],
      queueManagementPolicy: 'team_pending',
    }, {
      getTaskWorkflow: vi.fn(async () => workflowDag({
        orchestrationStatus: TaskOrchestrationStatus.WAITING_INPUT,
      })),
      answerTaskWorkflowHumanInput: vi.fn(async () => ({ resumed: true })),
    });
    registerTaskWorkflowTools(server as any, client as any, { teamRunId: 'team-run-1' } as any, auth);

    const result = await handlers.get('resolve_human_input')!({
      run_id: 'docs-1',
      task_id: taskId,
      question_id: '10000000-0000-4000-8000-000000000001',
      answer: 'full',
    });

    expect(result.isError).toBeUndefined();
    expect(client.answerTaskWorkflowHumanInput).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'docs-1',
      taskId,
      '10000000-0000-4000-8000-000000000001',
      { answer: 'full', actorType: 'TEAM_CONTROLLER', actorId: 'member-1' },
    );
  });
});
