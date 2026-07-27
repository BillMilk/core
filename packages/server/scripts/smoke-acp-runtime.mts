import { randomUUID } from 'node:crypto';
import { AgentType, RuntimeType } from '@agent-tower/shared';
import { ExecutionEnv } from '../src/executors/execution-env.js';
import { MsgStore } from '../src/output/msg-store.js';
import { AcpRuntimeDriver } from '../src/runtime/acp/acp-driver.js';

const workingDir = process.argv[2] || process.cwd();
const prompt = process.argv[3] || 'Reply with exactly ACP_OK and do not call tools.';
const providerId = process.argv[4] || undefined;
const expectedText = process.argv[5] || 'ACP_OK';
const requireTool = process.argv[6] === '--require-tool';
const msgStore = new MsgStore();
const streamEvents: string[] = [];
const processEvents: string[] = [];
const driver = new AcpRuntimeDriver();
const session = await driver.open({
  towerSessionId: `smoke-${randomUUID()}`,
  agentType: AgentType.CODEX,
  runtimeType: RuntimeType.ACP,
  variant: 'DEFAULT',
  providerId,
  workingDir,
  env: ExecutionEnv.default(workingDir),
}, {
  stream: (event) => streamEvents.push(event.type),
  process: async (event) => { processEvents.push(event.type); },
});

let report: Record<string, unknown> | undefined;
try {
  const turn = await session.runTurn({ turnId: randomUUID(), prompt, msgStore }, {
    stream: (event) => streamEvents.push(event.type),
    process: async (event) => { processEvents.push(event.type); },
  });
  const outcome = await Promise.race([
    turn.completion,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ACP smoke turn timed out')), 90_000);
      timer.unref?.();
    }),
  ]);
  const entries = msgStore.getSnapshot().entries;
  const assistantEntries = entries.filter((entry) => entry.entryType === 'assistant_message');
  const assistant = assistantEntries[assistantEntries.length - 1];
  if (!assistant) throw new Error('ACP smoke turn produced no assistant entry');
  if (assistant.content.trim() !== expectedText) {
    throw new Error(`ACP smoke turn returned unexpected assistant content: ${JSON.stringify(assistant.content)}`);
  }
  const tools = entries
    .filter((entry) => entry.entryType === 'tool_use')
    .map((entry) => ({
      title: entry.metadata?.toolName,
      kind: entry.metadata?.toolKind,
      status: entry.metadata?.status,
    }));
  if (requireTool && tools.length === 0) {
    throw new Error('ACP smoke turn produced no tool entry');
  }
  if (requireTool && tools.some((tool) => !tool.title || tool.title === 'Tool call')) {
    throw new Error('ACP smoke turn produced a tool entry without a human-readable title');
  }
  report = {
    ok: true,
    externalSessionId: session.externalSessionId,
    stopReason: outcome.stopReason,
    assistantContent: assistant.content,
    tools,
    streamEvents,
  };
} finally {
  await session.close();
}

if (!processEvents.includes('exited')) {
  throw new Error('ACP adapter shutdown produced no process exit event');
}
console.log(JSON.stringify({ ...report, processEvents }, null, 2));
