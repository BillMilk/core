import { access } from 'node:fs/promises';
import { AgentType, RuntimeType } from '@agent-tower/shared';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionEnv } from '../../executors/execution-env.js';

const processManagerState = vi.hoisted(() => ({ launchEnv: undefined as NodeJS.ProcessEnv | undefined }));

vi.mock('../acp/process-manager.js', () => ({
  AcpProcessManager: class {
    constructor(launch: { env: NodeJS.ProcessEnv }) {
      processManagerState.launchEnv = launch.env;
    }
    async start() {
      throw new Error('intentional spawn failure');
    }
    async stop() {}
  },
}));

import { AcpRuntimeDriver } from '../acp/acp-driver.js';

describe('AcpRuntimeDriver managed launch cleanup', () => {
  it('removes Pi managed credentials when process startup fails', async () => {
    const env = ExecutionEnv.default(process.cwd())
      .set('PI_PATH', process.execPath)
      .set('AGENT_TOWER_INTERNAL_TOKEN', 'cleanup-test-token');
    await expect(new AcpRuntimeDriver().open({
      towerSessionId: 'tower-cleanup',
      agentType: AgentType.PI_CODING_AGENT,
      runtimeType: RuntimeType.ACP,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env,
    }, {
      stream: vi.fn(),
      process: vi.fn(async () => undefined),
    })).rejects.toMatchObject({ stage: 'initialize' });

    const directory = processManagerState.launchEnv?.PI_CODING_AGENT_DIR;
    expect(directory).toBeTruthy();
    await expect(access(directory!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
