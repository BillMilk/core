import { TaskOrchestrationStatus, type TaskWorkflowDag } from '@agent-tower/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from '../context.js';
import type { AgentTowerClient } from '../http-client.js';

export interface TaskWorkflowToolAuth {
  resolveBoundTeamRunId(context?: McpContext | null): string | undefined;
  requireCurrentActiveTeamMember(
    client: AgentTowerClient,
    context: McpContext | null,
    teamRunId: string,
  ): Promise<string>;
}

const WorkflowNodeInput = z.object({
  key: z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/),
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).optional(),
  role: z.string().min(1).max(200),
  prompt_file: z.string().max(1_000).optional(),
  output_paths: z.array(z.string().min(1).max(1_000)).max(100).optional(),
  verify_id: z.string().max(200).optional(),
  depends_on_keys: z.array(z.string().min(1).max(120)).max(100).optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

const RunInput = z.object({
  run_id: z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/),
});
const MutationInput = RunInput.extend({
  nodes: z.array(WorkflowNodeInput).min(1).max(500),
});
const NodeInput = RunInput.extend({ task_id: z.string().uuid() });
const BlockInput = NodeInput.extend({ reason: z.string().min(1).max(2_000) });
const CompleteInput = NodeInput.extend({ reason: z.string().max(2_000).optional() });
const HumanInputRequestInput = NodeInput.extend({
  request_key: z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/),
  question: z.string().min(1).max(4_000),
  context: z.string().max(8_000).optional(),
  options: z.array(z.string().min(1).max(1_000)).max(20).optional(),
  allow_free_text: z.boolean().optional(),
});
const HumanInputAnswerInput = NodeInput.extend({
  question_id: z.string().uuid(),
  answer: z.string().min(1).max(20_000),
});

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function mapNodes(nodes: z.infer<typeof WorkflowNodeInput>[]) {
  return nodes.map((node) => ({
    key: node.key,
    title: node.title,
    description: node.description,
    role: node.role,
    promptFile: node.prompt_file,
    outputPaths: node.output_paths,
    verifyId: node.verify_id,
    dependsOnKeys: node.depends_on_keys,
    priority: node.priority,
  }));
}

async function resolveIdentity(
  client: AgentTowerClient,
  context: McpContext | null,
  auth: TaskWorkflowToolAuth,
) {
  const teamRunId = auth.resolveBoundTeamRunId(context);
  if (!teamRunId) throw new Error('A current TeamRun session is required for workflow tools.');
  const memberId = await auth.requireCurrentActiveTeamMember(client, context, teamRunId);
  const [teamRun, members] = await Promise.all([
    client.getTeamRun(teamRunId),
    client.listTeamMembers(teamRunId),
  ]);
  const member = members.find((item) => item.id === memberId);
  if (!member) throw new Error('Current TeamRun member was not found.');
  const rootTaskId = typeof teamRun.taskId === 'string' ? teamRun.taskId : context?.taskId;
  const projectId = teamRun.task?.projectId ?? context?.projectId;
  if (!rootTaskId || !projectId) throw new Error('The TeamRun root task context is incomplete.');
  return {
    teamRunId,
    memberId,
    invocationId: process.env.AGENT_TOWER_INVOCATION_ID ?? context?.invocationId ?? null,
    rootTaskId,
    projectId,
    workspaceId: teamRun.mainWorkspaceId ?? context?.workspaceId ?? null,
    member,
  };
}

function requireWorkflowManager(identity: Awaited<ReturnType<typeof resolveIdentity>>) {
  if (identity.member.queueManagementPolicy !== 'team_pending') {
    throw new Error('Only the TeamRun queue manager may create, extend, or complete workflow nodes.');
  }
}

function findNode(dag: TaskWorkflowDag, taskId: string) {
  const node = dag.nodes.find((item) => item.task.id === taskId);
  if (!node) throw new Error('task_id is not part of this workflow run.');
  return node;
}

function normalizedRoleValues(member: any): Set<string> {
  return new Set(
    [member.name, ...(Array.isArray(member.aliases) ? member.aliases : [])]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim().toLocaleLowerCase()),
  );
}

function requireNodeRole(identity: Awaited<ReturnType<typeof resolveIdentity>>, dag: TaskWorkflowDag, taskId: string) {
  const node = findNode(dag, taskId);
  if (!normalizedRoleValues(identity.member).has(node.role.trim().toLocaleLowerCase())) {
    throw new Error(`Workflow node '${node.key}' is assigned to role '${node.role}', not the current member.`);
  }
  return node;
}

function requireLease(node: ReturnType<typeof findNode>, memberId: string) {
  if (node.task.orchestrationClaimedBy !== memberId) {
    throw new Error('The current member does not own this workflow node lease.');
  }
}

export function registerTaskWorkflowTools(
  server: McpServer,
  client: AgentTowerClient,
  context: McpContext | null,
  auth: TaskWorkflowToolAuth,
): void {
  server.tool(
    'get_current_task_context',
    'Get the current TeamRun identity, root task, project, and workspace. IDs are derived from the active invocation and cannot be supplied by the model.',
    {},
    async () => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        return textResult({
          teamRunId: identity.teamRunId,
          memberId: identity.memberId,
          invocationId: identity.invocationId,
          rootTaskId: identity.rootTaskId,
          projectId: identity.projectId,
          workspaceId: identity.workspaceId,
          memberName: identity.member.name,
          aliases: identity.member.aliases ?? [],
          queueManagementPolicy: identity.member.queueManagementPolicy,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'create_task_dag',
    'Create an idempotent generic task workflow DAG under the current TeamRun root task. Only the queue manager may call this tool.',
    MutationInput.shape,
    async (params) => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        requireWorkflowManager(identity);
        return textResult(await client.createTaskWorkflow(identity.rootTaskId, {
          runId: params.run_id,
          nodes: mapNodes(params.nodes),
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'get_task_dag',
    'Read a generic task workflow DAG and its durable node states for the current TeamRun.',
    RunInput.shape,
    async (params) => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        return textResult(await client.getTaskWorkflow(identity.rootTaskId, params.run_id));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'extend_task_dag',
    'Idempotently add generic workflow nodes or dependencies to the current TeamRun DAG. Use for discovered work, partial follow-ups, and remediation.',
    MutationInput.shape,
    async (params) => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        requireWorkflowManager(identity);
        return textResult(await client.extendTaskWorkflow(
          identity.rootTaskId,
          params.run_id,
          mapNodes(params.nodes),
        ));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'claim_task_node',
    'Claim a READY workflow node assigned to the current member role. Worker identity is inferred from the active TeamRun invocation.',
    NodeInput.shape,
    async (params) => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        const dag = await client.getTaskWorkflow(identity.rootTaskId, params.run_id);
        const node = requireNodeRole(identity, dag, params.task_id);
        if (node.task.orchestrationClaimedBy === identity.memberId) return textResult(node.task);
        return textResult(await client.claimTask(params.task_id, identity.memberId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'start_task_node',
    'Move the current member owned workflow node from ASSIGNED to RUNNING.',
    NodeInput.shape,
    async (params) => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        const dag = await client.getTaskWorkflow(identity.rootTaskId, params.run_id);
        const node = requireNodeRole(identity, dag, params.task_id);
        requireLease(node, identity.memberId);
        return textResult(await client.transitionTaskOrchestration(params.task_id, {
          status: TaskOrchestrationStatus.RUNNING,
          workerId: identity.memberId,
          actorType: 'TEAM_MEMBER',
          actorId: identity.memberId,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'heartbeat_task_node',
    'Refresh the current member owned workflow node lease.',
    NodeInput.shape,
    async (params) => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        const dag = await client.getTaskWorkflow(identity.rootTaskId, params.run_id);
        const node = requireNodeRole(identity, dag, params.task_id);
        requireLease(node, identity.memberId);
        return textResult(await client.heartbeatTask(params.task_id, identity.memberId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'submit_task_node',
    'Submit the current member owned workflow node for independent REVIEW. This never marks the node DONE.',
    NodeInput.shape,
    async (params) => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        const dag = await client.getTaskWorkflow(identity.rootTaskId, params.run_id);
        let node = requireNodeRole(identity, dag, params.task_id);
        requireLease(node, identity.memberId);
        if (node.task.orchestrationStatus === TaskOrchestrationStatus.ASSIGNED) {
          await client.transitionTaskOrchestration(params.task_id, {
            status: TaskOrchestrationStatus.RUNNING,
            workerId: identity.memberId,
            actorType: 'TEAM_MEMBER',
            actorId: identity.memberId,
          });
          node = findNode(await client.getTaskWorkflow(identity.rootTaskId, params.run_id), params.task_id);
          requireLease(node, identity.memberId);
        }
        return textResult(await client.transitionTaskOrchestration(params.task_id, {
          status: TaskOrchestrationStatus.REVIEW,
          workerId: identity.memberId,
          actorType: 'TEAM_MEMBER',
          actorId: identity.memberId,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'request_human_input',
    'Suspend the current owned RUNNING node at a durable human decision gate. Only the affected dependency branch waits; this is not an execution failure. Worker identity is inferred from the active TeamRun invocation.',
    HumanInputRequestInput.shape,
    async (params) => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        let node = requireNodeRole(
          identity,
          await client.getTaskWorkflow(identity.rootTaskId, params.run_id),
          params.task_id,
        );
        requireLease(node, identity.memberId);
        if (node.task.orchestrationStatus === TaskOrchestrationStatus.ASSIGNED) {
          await client.transitionTaskOrchestration(params.task_id, {
            status: TaskOrchestrationStatus.RUNNING,
            workerId: identity.memberId,
            actorType: 'TEAM_MEMBER',
            actorId: identity.memberId,
          });
          node = findNode(await client.getTaskWorkflow(identity.rootTaskId, params.run_id), params.task_id);
          requireLease(node, identity.memberId);
        }
        const result = await client.requestTaskWorkflowHumanInput(
          identity.rootTaskId,
          params.run_id,
          params.task_id,
          {
            requestKey: params.request_key,
            question: params.question,
            context: params.context,
            options: params.options,
            allowFreeText: params.allow_free_text,
            workerId: identity.memberId,
            actorType: 'TEAM_MEMBER',
            actorId: identity.memberId,
          },
        );
        let roomNotificationWarning: string | undefined;
        try {
          const optionText = params.options?.length
            ? `\nOptions:\n${params.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`
            : '';
          await client.createRoomMessage(identity.teamRunId, {
            content: `[Human input required]\nrunId: ${params.run_id}\nnodeKey: ${node.key}\nquestionId: ${result.humanInput.questionId}\nQuestion: ${params.question}${params.context ? `\nContext: ${params.context}` : ''}${optionText}`,
            kind: 'decision',
            senderType: 'agent',
            senderId: identity.memberId,
            senderInvocationId: identity.invocationId,
          });
        } catch (notificationError) {
          roomNotificationWarning = notificationError instanceof Error
            ? notificationError.message
            : String(notificationError);
        }
        return textResult({ ...result, ...(roomNotificationWarning ? { roomNotificationWarning } : {}) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'resolve_human_input',
    'Record an explicit user answer for a WAITING_INPUT workflow node and release that exact node back to READY. Queue manager only; never infer or invent the answer.',
    HumanInputAnswerInput.shape,
    async (params) => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        requireWorkflowManager(identity);
        findNode(await client.getTaskWorkflow(identity.rootTaskId, params.run_id), params.task_id);
        return textResult(await client.answerTaskWorkflowHumanInput(
          identity.rootTaskId,
          params.run_id,
          params.task_id,
          params.question_id,
          { answer: params.answer, actorType: 'TEAM_CONTROLLER', actorId: identity.memberId },
        ));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'complete_task_node',
    'Accept a REVIEW workflow node after deterministic validation, mark it DONE, and release newly unblocked nodes. Queue manager only.',
    CompleteInput.shape,
    async (params) => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        requireWorkflowManager(identity);
        findNode(await client.getTaskWorkflow(identity.rootTaskId, params.run_id), params.task_id);
        return textResult(await client.completeTaskWorkflowNode(
          identity.rootTaskId,
          params.run_id,
          params.task_id,
          { actorType: 'TEAM_CONTROLLER', actorId: identity.memberId, reason: params.reason },
        ));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'block_task_node',
    'Block the current member owned workflow node with a concrete reason. A claimed ASSIGNED node is started before it is blocked.',
    BlockInput.shape,
    async (params) => {
      try {
        const identity = await resolveIdentity(client, context, auth);
        const dag = await client.getTaskWorkflow(identity.rootTaskId, params.run_id);
        let node = requireNodeRole(identity, dag, params.task_id);
        requireLease(node, identity.memberId);
        if (node.task.orchestrationStatus === TaskOrchestrationStatus.ASSIGNED) {
          await client.transitionTaskOrchestration(params.task_id, {
            status: TaskOrchestrationStatus.RUNNING,
            workerId: identity.memberId,
            actorType: 'TEAM_MEMBER',
            actorId: identity.memberId,
          });
          node = findNode(await client.getTaskWorkflow(identity.rootTaskId, params.run_id), params.task_id);
          requireLease(node, identity.memberId);
        }
        return textResult(await client.transitionTaskOrchestration(params.task_id, {
          status: TaskOrchestrationStatus.BLOCKED,
          workerId: identity.memberId,
          actorType: 'TEAM_MEMBER',
          actorId: identity.memberId,
          reason: params.reason,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
