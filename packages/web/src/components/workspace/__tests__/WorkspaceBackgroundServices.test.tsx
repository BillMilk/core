// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspaceBackgroundServiceDto,
  WorkspaceBackgroundServiceLogsResponse,
} from '@agent-tower/shared'
import { WorkspaceBackgroundServices } from '../WorkspaceBackgroundServices'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { listHookMock, logsHookMock, listRefetchMock, logsRefetchMock } = vi.hoisted(() => ({
  listHookMock: vi.fn(),
  logsHookMock: vi.fn(),
  listRefetchMock: vi.fn(),
  logsRefetchMock: vi.fn(),
}))

vi.mock('@/hooks/use-workspace-services', () => ({
  useWorkspaceBackgroundServices: (...args: unknown[]) => listHookMock(...args),
  useWorkspaceBackgroundServiceLogs: (...args: unknown[]) => logsHookMock(...args),
}))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ locale: 'en', t: (source: string) => source }),
}))

function service(name: string, overrides: Partial<WorkspaceBackgroundServiceDto> = {}): WorkspaceBackgroundServiceDto {
  return {
    id: `service-${name}`,
    workspaceId: 'workspace-1',
    name,
    command: 'pnpm',
    args: ['dev'],
    relativeCwd: 'packages/web',
    desiredState: 'RUNNING',
    runtimeState: 'RUNNING',
    runtimeInstanceId: `runtime-${name}`,
    pid: 123,
    exitCode: null,
    lastError: null,
    startedAt: '2026-07-31T02:00:00.000Z',
    stoppedAt: null,
    createdAt: '2026-07-31T02:00:00.000Z',
    updatedAt: '2026-07-31T02:00:00.000Z',
    ...overrides,
  }
}

const logs: WorkspaceBackgroundServiceLogsResponse = {
  serviceName: 'web',
  runtimeState: 'RUNNING',
  runtimeInstanceId: 'runtime-web',
  entries: [{
    seq: 1,
    timestamp: '2026-07-31T02:00:01.000Z',
    data: '\u001b]0;hidden title\u0007\u001b]8;;https://example.com\u001b\\\u001b[1;32mready\u001b[0m\n',
  }],
  oldestSeq: 1,
  nextSeq: 2,
  reset: false,
  truncated: true,
  hasMore: false,
}

describe('WorkspaceBackgroundServices', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    listHookMock.mockReset().mockReturnValue({
      data: [service('web'), service('api', { relativeCwd: 'packages/server' })],
      isLoading: false,
      isError: false,
      refetch: listRefetchMock,
    })
    logsHookMock.mockReset().mockReturnValue({
      data: logs,
      isLoading: false,
      isError: false,
      refetch: logsRefetchMock,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows service metadata and read-only bounded logs without control actions', async () => {
    await act(async () => {
      root.render(<WorkspaceBackgroundServices workspaceId="workspace-1" />)
    })

    expect(container.textContent).toContain('web')
    expect(container.textContent).toContain('["pnpm","dev"]')
    expect(container.textContent).toContain('packages/web')
    expect(container.querySelector('[role="log"] pre')?.textContent).toBe('ready\n')
    expect(container.textContent).not.toContain('hidden title')
    expect(container.textContent).toContain('Earlier log output is unavailable.')
    const actionLabels = Array.from(container.querySelectorAll('button'))
      .map(button => button.getAttribute('aria-label') ?? button.textContent)
    expect(actionLabels).not.toContain('Stop')
    expect(actionLabels).not.toContain('Restart')
    expect(actionLabels).not.toContain('Close')
    expect(actionLabels).not.toContain('Input')

    const apiButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('api'))
    await act(async () => apiButton?.click())
    expect(logsHookMock).toHaveBeenLastCalledWith('workspace-1', 'api', 'runtime-api', true)
  })

  it('renders log text without interpreting markup', async () => {
    logsHookMock.mockReturnValueOnce({
      data: {
        ...logs,
        entries: [{
          seq: 1,
          timestamp: '2026-07-31T02:00:01.000Z',
          data: '<img src=x onerror="globalThis.compromised=true">\n',
        }],
      },
      isLoading: false,
      isError: false,
      refetch: logsRefetchMock,
    })

    await act(async () => {
      root.render(<WorkspaceBackgroundServices workspaceId="workspace-1" />)
    })

    expect(container.querySelector('[role="log"] pre')?.textContent)
      .toBe('<img src=x onerror="globalThis.compromised=true">\n')
    expect(container.querySelector('[role="log"] img')).toBeNull()
  })

  it('shows every structured command token with reversible JSON escaping', async () => {
    listHookMock.mockReturnValueOnce({
      data: [service('escaped', {
        command: 'run tool',
        args: ['', 'quote"value', 'back\\slash', '$HOME', 'semi;colon', 'pipe|value'],
      })],
      isLoading: false,
      isError: false,
      refetch: listRefetchMock,
    })

    await act(async () => {
      root.render(<WorkspaceBackgroundServices workspaceId="workspace-1" />)
    })

    const expected = JSON.stringify([
      'run tool',
      '',
      'quote"value',
      'back\\slash',
      '$HOME',
      'semi;colon',
      'pipe|value',
    ])
    expect(container.textContent).toContain(expected)
    expect(JSON.parse(expected)).toEqual([
      'run tool',
      '',
      'quote"value',
      'back\\slash',
      '$HOME',
      'semi;colon',
      'pipe|value',
    ])
  })

  it('bounds long command metadata without truncating its reversible JSON or the log viewport', async () => {
    const longArgument = `const value = "${'x'.repeat(400)}"; console.log(value)`
    listHookMock.mockReturnValueOnce({
      data: [service('long-command', {
        command: 'node',
        args: ['-e', longArgument],
      })],
      isLoading: false,
      isError: false,
      refetch: listRefetchMock,
    })

    await act(async () => {
      root.render(<WorkspaceBackgroundServices workspaceId="workspace-1" />)
    })

    const expected = JSON.stringify(['node', '-e', longArgument])
    const details = container.querySelector('[aria-label="long-command Details"]')
    expect(details?.classList).toContain('max-h-32')
    expect(details?.classList).toContain('overflow-y-auto')
    expect(details?.getAttribute('tabindex')).toBe('0')
    expect(details?.textContent).toContain(expected)
    expect(JSON.parse(expected)).toEqual(['node', '-e', longArgument])

    const logViewport = container.querySelector('[role="log"]')
    expect(logViewport?.classList).toContain('min-h-0')
    expect(logViewport?.classList).toContain('flex-1')
    expect(logViewport?.textContent).toContain('ready')
  })

  it('renders loading, empty, and error states in the service list', async () => {
    listHookMock.mockReturnValueOnce({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: listRefetchMock,
    })
    await act(async () => {
      root.render(<WorkspaceBackgroundServices workspaceId="workspace-1" />)
    })
    expect(container.textContent).toContain('Loading background services...')

    listHookMock.mockReturnValueOnce({
      data: [],
      isLoading: false,
      isError: false,
      refetch: listRefetchMock,
    })
    await act(async () => {
      root.render(<WorkspaceBackgroundServices workspaceId="workspace-1" />)
    })
    expect(container.textContent).toContain('No background services')

    listHookMock.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: listRefetchMock,
    })
    await act(async () => {
      root.render(<WorkspaceBackgroundServices workspaceId="workspace-1" />)
    })
    expect(container.textContent).toContain('Failed to load background services.')
  })
})
