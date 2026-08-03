const AGENT_DOWNLOAD_DIRECTIVE = /^[ \t]{0,3}::agent-download\{file="([^"\r\n]+)"\}[ \t]*$/
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/
const FENCE_START = /^[ \t]{0,3}(`{3,}|~{3,})/

export const AGENT_DOWNLOAD_DIRECTIVE_EXAMPLE = '::agent-download{file="output/report.pdf"}'
export const MAX_AGENT_DOWNLOAD_PATH_LENGTH = 1024

function isFenceClose(line: string, marker: string): boolean {
  const escaped = marker[0] === '`' ? '`' : '~'
  return new RegExp(`^[ \\t]{0,3}${escaped}{${marker.length},}[ \\t]*$`).test(line)
}

export function normalizeAgentDownloadPath(value: string): string | null {
  if (!value || value.length > MAX_AGENT_DOWNLOAD_PATH_LENGTH) return null
  if (value !== value.trim() || value.includes('\\') || /[\0-\x1f\x7f]/.test(value)) return null
  if (value.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(value)) return null

  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

export function parseAgentDownloadDirective(line: string): string | null {
  const match = line.match(AGENT_DOWNLOAD_DIRECTIVE)
  return match ? normalizeAgentDownloadPath(match[1]) : null
}

export function extractAgentDownloadPaths(content: string): string[] {
  const paths = new Set<string>()
  let fenceMarker: string | null = null

  for (const line of content.split(/\r?\n/)) {
    if (fenceMarker) {
      if (isFenceClose(line, fenceMarker)) fenceMarker = null
      continue
    }

    const fence = line.match(FENCE_START)
    if (fence) {
      fenceMarker = fence[1]
      continue
    }

    const file = parseAgentDownloadDirective(line)
    if (file) paths.add(file)
  }

  return [...paths]
}
