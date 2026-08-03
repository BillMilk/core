import { AGENT_DOWNLOAD_DIRECTIVE_EXAMPLE } from '@agent-tower/shared';

const AGENT_OUTPUT_INTENT_INSTRUCTIONS = [
  '## Agent Tower file delivery',
  'When you finish a user-requested downloadable deliverable, add this directive on its own line after the file exists:',
  AGENT_DOWNLOAD_DIRECTIVE_EXAMPLE,
  'Replace the example with the file path relative to the current working directory. Use forward slashes, never an absolute path or `..`, and do not wrap the directive in a code fence.',
].join('\n');

export function appendAgentOutputIntentInstructions(prompt: string): string {
  return `${prompt}\n\n${AGENT_OUTPUT_INTENT_INSTRUCTIONS}`;
}
