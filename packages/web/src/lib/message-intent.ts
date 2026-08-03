import { getApiBaseUrl } from '@/lib/api-base-url'
import { normalizeAgentDownloadPath, parseAgentDownloadDirective } from '@agent-tower/shared'

const CODEX_INLINE_VIS_PATH = '/__agent-tower/message-intent/codex-inline-vis'
const AGENT_DOWNLOAD_PATH = '/__agent-tower/message-intent/agent-download'
const CODEX_INLINE_VIS_DIRECTIVE = /^[ \t]{0,3}::codex-inline-vis\{file="([^"\r\n]+)"\}[ \t]*$/
const CODEX_INLINE_VIS_FILE = /^[a-z0-9][a-z0-9-]*\.html$/
const FENCE_START = /^[ \t]{0,3}(`{3,}|~{3,})/

export type MessageIntent =
  | { type: 'codex-inline-visualization'; file: string }
  | { type: 'agent-download'; file: string }

function isFenceClose(line: string, marker: string): boolean {
  const escaped = marker[0] === '`' ? '`' : '~'
  return new RegExp(`^[ \\t]{0,3}${escaped}{${marker.length},}[ \\t]*$`).test(line)
}

export function prepareMessageMarkdown(content: string): string {
  let fenceMarker: string | null = null

  return content.split(/\r?\n/).map((line) => {
    if (fenceMarker) {
      if (isFenceClose(line, fenceMarker)) fenceMarker = null
      return line
    }

    const fence = line.match(FENCE_START)
    if (fence) {
      fenceMarker = fence[1]
      return line
    }

    const directive = line.match(CODEX_INLINE_VIS_DIRECTIVE)
    if (directive && CODEX_INLINE_VIS_FILE.test(directive[1])) {
      const href = `${CODEX_INLINE_VIS_PATH}?file=${encodeURIComponent(directive[1])}`
      return `[${directive[1]}](${href})`
    }

    const downloadFile = parseAgentDownloadDirective(line)
    if (!downloadFile) return line
    const href = `${AGENT_DOWNLOAD_PATH}?file=${encodeURIComponent(downloadFile)}`
    return `[${downloadFile}](${href})`
  }).join('\n')
}

export function resolveMessageIntent(href: string): MessageIntent | null {
  try {
    const url = new URL(href, 'http://agent-tower.local')
    const file = url.searchParams.get('file')
    if (!file) return null
    if (url.pathname === CODEX_INLINE_VIS_PATH && CODEX_INLINE_VIS_FILE.test(file)) {
      return { type: 'codex-inline-visualization', file }
    }
    if (url.pathname === AGENT_DOWNLOAD_PATH) {
      const normalized = normalizeAgentDownloadPath(file)
      return normalized ? { type: 'agent-download', file: normalized } : null
    }
    return null
  } catch {
    return null
  }
}

export function agentVisualizationUrl(sessionId: string, file: string): string {
  return `${getApiBaseUrl()}/sessions/${encodeURIComponent(sessionId)}/visualizations/${encodeURIComponent(file)}`
}

export function agentArtifactDownloadUrl(sessionId: string, file: string): string {
  const params = new URLSearchParams({ path: file })
  return `${getApiBaseUrl()}/sessions/${encodeURIComponent(sessionId)}/artifacts/download?${params.toString()}`
}
