/**
 * LogAdapter Token 转换测试
 * Property 4: LogAdapter Token 转换正确性
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { normalizedEntryToLogEntry } from '../log-adapter.js'
import type { NormalizedEntry } from '../log-adapter.js'

function makeTokenUsageEntry(
  totalTokens: number,
  modelContextWindow?: number
): NormalizedEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    entryType: 'token_usage_info',
    content: `Tokens: ${totalTokens}`,
    metadata: {
      tokenUsage: { totalTokens, modelContextWindow },
    },
  }
}

describe('Feature: token-usage-display, Property 4: LogAdapter Token 转换正确性', () => {
  it('should convert token_usage_info NormalizedEntry to LogEntry with tokenUsage', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.option(fc.nat(), { nil: undefined }),
        (totalTokens, modelContextWindow) => {
          const entry = makeTokenUsageEntry(totalTokens, modelContextWindow)
          const logEntry = normalizedEntryToLogEntry(entry)

          expect(logEntry).not.toBeNull()
          expect(logEntry!.timestamp).toBe(entry.timestamp)
          expect(logEntry!.tokenUsage).toBeDefined()
          expect(logEntry!.tokenUsage!.totalTokens).toBe(totalTokens)
          expect(logEntry!.tokenUsage!.modelContextWindow).toBe(modelContextWindow)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('should return null when tokenUsage metadata is missing', () => {
    const entry: NormalizedEntry = {
      id: 'test-1',
      timestamp: Date.now(),
      entryType: 'token_usage_info',
      content: '',
    }
    const logEntry = normalizedEntryToLogEntry(entry)
    expect(logEntry).toBeNull()
  })

  it('should default totalTokens to 0 when undefined', () => {
    const entry: NormalizedEntry = {
      id: 'test-2',
      timestamp: Date.now(),
      entryType: 'token_usage_info',
      content: '',
      metadata: {
        tokenUsage: {},
      },
    }
    const logEntry = normalizedEntryToLogEntry(entry)
    expect(logEntry).not.toBeNull()
    expect(logEntry!.tokenUsage!.totalTokens).toBe(0)
    expect(logEntry!.tokenUsage!.modelContextWindow).toBeUndefined()
  })
})

describe('ACP tool log projection', () => {
  it('prefers the ACP display title and forwards structured tool details', () => {
    const entry: NormalizedEntry = {
      id: 'acp-tool-1',
      timestamp: 123,
      entryType: 'tool_use',
      content: 'Output\ndone',
      metadata: {
        action: 'command_run',
        toolName: 'Read browser skill',
        toolId: 'tool-1',
        toolKind: 'execute',
        status: 'success',
        toolContent: [{ type: 'text', text: 'done' }],
        toolLocations: [{ path: '/tmp/example.ts', line: 12 }],
        toolInputSummary: '{"path":"/tmp/example.ts"}',
        toolOutputSummary: 'done',
      },
    }

    expect(normalizedEntryToLogEntry(entry)).toMatchObject({
      title: 'Read browser skill ✓',
      tool: {
        name: 'Read browser skill',
        kind: 'execute',
        status: 'success',
        content: [{ type: 'text', text: 'done' }],
        locations: [{ path: '/tmp/example.ts', line: 12 }],
        inputSummary: '{"path":"/tmp/example.ts"}',
        outputSummary: 'done',
      },
    })
  })

  it('maps non-blocking runtime diagnostics to warning logs', () => {
    const entry: NormalizedEntry = {
      id: 'acp-warning-1',
      timestamp: 456,
      entryType: 'warning_message',
      content: 'MCP server `agent-tower` failed to start: connection closed',
      metadata: {
        warning: 'MCP server `agent-tower` failed to start: connection closed',
      },
    }

    expect(normalizedEntryToLogEntry(entry)).toEqual({
      id: 'acp-warning-1',
      timestamp: 456,
      type: 'Warning',
      content: 'MCP server `agent-tower` failed to start: connection closed',
    })
  })
})
