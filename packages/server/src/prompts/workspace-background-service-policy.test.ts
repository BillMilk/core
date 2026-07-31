import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceRuntimePrompt,
  withWorkspaceBackgroundServicePolicy,
} from './workspace-background-service-policy.js';

describe('workspace background service policy', () => {
  it('routes long-running commands to MCP without changing the user prompt', () => {
    const prompt = withWorkspaceBackgroundServicePolicy('Run the app');
    expect(prompt).toContain('start_workspace_service');
    expect(prompt).toContain('Do not start those commands in the agent terminal');
    expect(prompt).toContain('Run the app');
  });

  it('injects only workspace chat turns', () => {
    expect(buildWorkspaceRuntimePrompt({ context: 'WORKSPACE', purpose: 'CHAT' }, 'hello'))
      .toContain('start_workspace_service');
    expect(buildWorkspaceRuntimePrompt({ context: 'WORKSPACE', purpose: 'COMMIT_MSG' }, 'hello'))
      .toBe('hello');
    expect(buildWorkspaceRuntimePrompt({ context: 'CONVERSATION', purpose: 'CHAT', conversationId: 'c1' }, 'hello'))
      .toBe('hello');
  });
});
