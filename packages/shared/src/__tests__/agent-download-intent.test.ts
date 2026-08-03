import { describe, expect, it } from 'vitest';
import {
  extractAgentDownloadPaths,
  normalizeAgentDownloadPath,
  parseAgentDownloadDirective,
} from '../agent-download-intent.js';

describe('agent download intent', () => {
  it('accepts portable relative paths and rejects path escapes', () => {
    expect(normalizeAgentDownloadPath('output/final report.pdf')).toBe('output/final report.pdf');
    expect(normalizeAgentDownloadPath('../secret.txt')).toBeNull();
    expect(normalizeAgentDownloadPath('/tmp/secret.txt')).toBeNull();
    expect(normalizeAgentDownloadPath('C:\\secret.txt')).toBeNull();
    expect(normalizeAgentDownloadPath('output\\report.pdf')).toBeNull();
  });

  it('only extracts complete directives outside fenced code blocks', () => {
    const content = [
      'Download:',
      '::agent-download{file="output/report.pdf"}',
      '```text',
      '::agent-download{file="output/example.pdf"}',
      '```',
      '::agent-download{file="output/report.pdf"}',
    ].join('\n');

    expect(parseAgentDownloadDirective('::agent-download{file="output/report.pdf"}'))
      .toBe('output/report.pdf');
    expect(extractAgentDownloadPaths(content)).toEqual(['output/report.pdf']);
  });
});
