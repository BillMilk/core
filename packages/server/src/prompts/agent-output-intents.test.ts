import { describe, expect, it } from 'vitest';
import { appendAgentOutputIntentInstructions } from './agent-output-intents.js';

describe('agent output intent prompt', () => {
  it('teaches agents the safe download directive without changing the user text', () => {
    const prompt = appendAgentOutputIntentInstructions('Create a report');

    expect(prompt.startsWith('Create a report\n\n')).toBe(true);
    expect(prompt).toContain('::agent-download{file="output/report.pdf"}');
    expect(prompt).toContain('relative to the current working directory');
    expect(prompt).toContain('do not wrap the directive in a code fence');
  });
});
