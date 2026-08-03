import { describe, expect, it } from 'vitest'
import {
  agentVisualizationUrl,
  agentArtifactDownloadUrl,
  prepareMessageMarkdown,
  resolveMessageIntent,
} from '@/lib/message-intent'

describe('message intents', () => {
  it('turns a Codex inline visualization directive into an internal intent link', () => {
    const markdown = prepareMessageMarkdown([
      'Architecture:',
      '::codex-inline-vis{file="agent-tower-architecture.html"}',
    ].join('\n'))

    expect(markdown).toContain('[agent-tower-architecture.html](')
    const href = markdown.match(/\]\(([^)]+)\)/)?.[1]
    expect(href && resolveMessageIntent(href)).toEqual({
      type: 'codex-inline-visualization',
      file: 'agent-tower-architecture.html',
    })
  })

  it('does not interpret directives inside fenced code blocks or incomplete lines', () => {
    const content = [
      '```text',
      '::codex-inline-vis{file="example.html"}',
      '```',
      '::codex-inline-vis{file="unfinished.html"',
    ].join('\n')

    expect(prepareMessageMarkdown(content)).toBe(content)
  })

  it('turns a safe agent download directive into an internal intent link', () => {
    const markdown = prepareMessageMarkdown('::agent-download{file="output/final report.pdf"}')
    const href = markdown.match(/\]\(([^)]+)\)/)?.[1]

    expect(href && resolveMessageIntent(href)).toEqual({
      type: 'agent-download',
      file: 'output/final report.pdf',
    })
  })

  it('rejects unsafe download paths and directives inside code fences', () => {
    const content = [
      '::agent-download{file="../secret.txt"}',
      '```text',
      '::agent-download{file="output/report.pdf"}',
      '```',
    ].join('\n')

    expect(prepareMessageMarkdown(content)).toBe(content)
    expect(resolveMessageIntent(
      '/__agent-tower/message-intent/agent-download?file=../secret.txt',
    )).toBeNull()
  })

  it('does not interpret filenames outside the Codex visualization contract', () => {
    const content = '::codex-inline-vis{file="../secret.html"}'

    expect(prepareMessageMarkdown(content)).toBe(content)
    expect(resolveMessageIntent(
      '/__agent-tower/message-intent/codex-inline-vis?file=../secret.html',
    )).toBeNull()
  })

  it('builds a guarded session visualization URL', () => {
    expect(agentVisualizationUrl('session/1', 'result file.html'))
      .toContain('/sessions/session%2F1/visualizations/result%20file.html')
  })

  it('builds a session-scoped artifact download URL', () => {
    expect(agentArtifactDownloadUrl('session/1', 'output/final report.pdf'))
      .toContain('/sessions/session%2F1/artifacts/download?path=output%2Ffinal+report.pdf')
  })
})
