import type * as acp from '@agentclientprotocol/sdk';
import type {
  AgentType,
  RuntimePermissionMode,
} from '@agent-tower/shared';
import type { AvailabilityInfo } from '../../../executors/base.executor.js';
import type { Provider } from '../../../executors/providers.js';
import type { RuntimeOpenInput } from '../../contracts.js';

export interface AcpAgentProfile {
  agentType: AgentType;
  environment: Record<string, string>;
  permissionMode: RuntimePermissionMode;
  appendPrompt?: string;
  model?: string;
  effort?: string;
  settings?: Record<string, unknown>;
}

export interface AcpLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type AcpSessionBootstrapResponse = Pick<acp.NewSessionResponse, 'modes' | 'configOptions'>;

export interface AcpAgentDefinition {
  readonly agentType: AgentType;
  readonly displayName: string;
  readonly initializeTimeoutMs?: number;
  projectProvider(provider: Provider | null, inheritedEnvironment: Record<string, string>): AcpAgentProfile;
  resolveLaunch(input: RuntimeOpenInput, profile: AcpAgentProfile): Promise<AcpLaunchSpec>;
  checkAvailability(provider: Provider): Promise<AvailabilityInfo>;
  sessionMetadata?(profile: AcpAgentProfile): { _meta: Record<string, unknown> };
  configureSession?(
    context: acp.ClientContext,
    sessionId: string,
    response: AcpSessionBootstrapResponse,
    profile: AcpAgentProfile,
  ): Promise<void>;
}
