import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findSession,
  findWorkspace,
  findInvocation,
  findInvocations,
} = vi.hoisted(() => ({
  findSession: vi.fn(),
  findWorkspace: vi.fn(),
  findInvocation: vi.fn(),
  findInvocations: vi.fn(),
}));

vi.mock('../../utils/index.js', () => ({
  prisma: {
    session: { findUnique: findSession },
    workspace: { findFirst: findWorkspace },
    agentInvocation: {
      findFirst: findInvocation,
      findMany: findInvocations,
    },
  },
}));

import { systemRoutes } from '../system.js';
import { accessAuthHook } from '../../middleware/access-auth.js';
import {
  AGENT_API_CREDENTIAL_HEADER,
  clearAgentApiCredentials,
  createAgentApiCredential,
} from '../../utils/agent-api-credential.js';

const workspace = {
  id: 'workspace-shared',
  branchName: 'team/main',
  workspaceKind: 'WORKTREE',
  workingDir: '/workspaces/shared',
  worktreePath: '/workspaces/shared',
  task: {
    id: 'task-1',
    title: 'Shared task',
    project: { id: 'project-1', name: 'Project' },
  },
};

async function buildTestApp(agentIdentity?: {
  sessionId: string;
  invocationId: string | null;
}) {
  const app = Fastify();
  let credential: string | undefined;
  if (agentIdentity) {
    credential = createAgentApiCredential(agentIdentity);
    app.addHook('onRequest', accessAuthHook);
  }
  await app.register(systemRoutes, { prefix: '/api' });
  return { app, credential };
}

describe('system workspace context', () => {
  beforeEach(() => {
    findSession.mockReset();
    findWorkspace.mockReset();
    findInvocation.mockReset();
    findInvocations.mockReset();
    clearAgentApiCredentials();
  });

  it('uses the credential-bound invocation when multiple invocations share a workspace', async () => {
    findSession.mockResolvedValue({ workspace });
    findInvocation.mockResolvedValue({
      id: 'invocation-bound',
      teamRunId: 'team-run-1',
      memberId: 'member-bound',
    });
    findInvocations.mockResolvedValue([
      { id: 'invocation-bound', teamRunId: 'team-run-1', memberId: 'member-bound' },
      { id: 'invocation-other', teamRunId: 'team-run-1', memberId: 'member-other' },
    ]);
    const { app, credential } = await buildTestApp({
      sessionId: 'session-bound',
      invocationId: 'invocation-bound',
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/system/workspace-context?path=%2Fworkspaces%2Fshared&sessionId=session-spoofed',
        headers: { [AGENT_API_CREDENTIAL_HEADER]: credential! },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        workspaceId: 'workspace-shared',
        teamRunId: 'team-run-1',
        memberId: 'member-bound',
        invocationId: 'invocation-bound',
      });
      expect(findSession).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'session-bound' },
      }));
      expect(findInvocation).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          id: 'invocation-bound',
          workspaceId: 'workspace-shared',
          sessionId: 'session-bound',
        },
      }));
      expect(findWorkspace).not.toHaveBeenCalled();
      expect(findInvocations).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not infer a TeamRun identity for a credential without an invocation', async () => {
    findSession.mockResolvedValue({ workspace });
    findInvocations.mockResolvedValue([
      { id: 'invocation-other', teamRunId: 'team-run-1', memberId: 'member-other' },
    ]);
    const { app, credential } = await buildTestApp({
      sessionId: 'session-solo',
      invocationId: null,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/system/workspace-context?path=%2Fworkspaces%2Fshared',
        headers: { [AGENT_API_CREDENTIAL_HEADER]: credential! },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ workspaceId: 'workspace-shared' });
      expect(response.json()).not.toHaveProperty('teamRunId');
      expect(response.json()).not.toHaveProperty('memberId');
      expect(response.json()).not.toHaveProperty('invocationId');
      expect(findInvocation).not.toHaveBeenCalled();
      expect(findInvocations).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not fall back when the credential-bound invocation does not match the workspace', async () => {
    findSession.mockResolvedValue({ workspace });
    findInvocation.mockResolvedValue(null);
    findInvocations.mockResolvedValue([
      { id: 'invocation-other', teamRunId: 'team-run-1', memberId: 'member-other' },
    ]);
    const { app, credential } = await buildTestApp({
      sessionId: 'session-bound',
      invocationId: 'invocation-mismatched',
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/system/workspace-context?path=%2Fworkspaces%2Fshared',
        headers: { [AGENT_API_CREDENTIAL_HEADER]: credential! },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).not.toHaveProperty('teamRunId');
      expect(response.json()).not.toHaveProperty('memberId');
      expect(response.json()).not.toHaveProperty('invocationId');
      expect(findInvocation).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          id: 'invocation-mismatched',
          workspaceId: 'workspace-shared',
          sessionId: 'session-bound',
        },
      }));
      expect(findInvocations).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('keeps cwd inference as a fallback for MCP callers without a bound credential', async () => {
    findWorkspace.mockResolvedValue(workspace);
    findInvocations.mockResolvedValue([
      { id: 'invocation-only', teamRunId: 'team-run-1', memberId: 'member-only' },
    ]);
    const { app } = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/system/workspace-context?path=%2Fworkspaces%2Fshared',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        workspaceId: 'workspace-shared',
        teamRunId: 'team-run-1',
        memberId: 'member-only',
        invocationId: 'invocation-only',
      });
      expect(findInvocations).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
