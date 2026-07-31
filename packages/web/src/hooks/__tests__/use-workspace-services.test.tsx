// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceBackgroundServiceLogsResponse } from '@agent-tower/shared'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: getMock },
}))

import { queryKeys } from '../query-keys'
import {
  mergeWorkspaceServiceLogs,
  useWorkspaceBackgroundServiceLogs,
} from '../use-workspace-services'

function response(
  entries: WorkspaceBackgroundServiceLogsResponse['entries'],
  nextSeq: number,
  options: {
    runtimeInstanceId?: string | null
    reset?: boolean
    truncated?: boolean
    hasMore?: boolean
  } = {},
): WorkspaceBackgroundServiceLogsResponse {
  return {
    serviceName: 'web',
    runtimeState: 'RUNNING',
    runtimeInstanceId: options.runtimeInstanceId === undefined
      ? 'runtime-1'
      : options.runtimeInstanceId,
    entries,
    oldestSeq: entries[0]?.seq ?? nextSeq,
    nextSeq,
    reset: options.reset ?? false,
    truncated: options.truncated ?? false,
    hasMore: options.hasMore ?? false,
  }
}

function Probe({ runtimeInstanceId = 'runtime-1' }: { runtimeInstanceId?: string | null }) {
  const query = useWorkspaceBackgroundServiceLogs('workspace-1', 'web', runtimeInstanceId)
  return <div data-next-seq={query.data?.nextSeq}>{query.data?.entries.map(entry => entry.data).join('') ?? ''}</div>
}

describe('useWorkspaceBackgroundServiceLogs', () => {
  let container: HTMLDivElement
  let root: Root
  let queryClient: QueryClient

  beforeEach(() => {
    getMock.mockReset()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    queryClient.clear()
    container.remove()
  })

  it('uses the log response generation when the service list is stale or unavailable', async () => {
    getMock
      .mockResolvedValueOnce(response([
        { seq: 1, timestamp: '2026-07-31T00:00:00.000Z', data: 'one\n' },
        { seq: 2, timestamp: '2026-07-31T00:00:01.000Z', data: 'two\n' },
      ], 3))
      .mockResolvedValueOnce(response([
        { seq: 3, timestamp: '2026-07-31T00:00:02.000Z', data: 'three\n' },
      ], 4))
      .mockResolvedValueOnce(response([
        { seq: 1, timestamp: '2026-07-31T00:00:03.000Z', data: 'new-one\n' },
        { seq: 2, timestamp: '2026-07-31T00:00:04.000Z', data: 'new-two\n' },
        { seq: 3, timestamp: '2026-07-31T00:00:05.000Z', data: 'new-three\n' },
      ], 4, { runtimeInstanceId: 'runtime-2', reset: true }))
      .mockResolvedValueOnce(response([
        { seq: 4, timestamp: '2026-07-31T00:00:06.000Z', data: 'new-four\n' },
      ], 5, { runtimeInstanceId: 'runtime-2' }))

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      )
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(getMock).toHaveBeenNthCalledWith(
      1,
      '/workspaces/workspace-1/services/web/logs?limit=200&runtimeInstanceId=runtime-1&afterSeq=0',
    )
    expect(container.textContent).toBe('one\ntwo\n')

    const queryKey = queryKeys.workspaceServices.logs('workspace-1', 'web')
    await act(async () => {
      await queryClient.refetchQueries({ queryKey, exact: true })
    })
    expect(getMock).toHaveBeenNthCalledWith(
      2,
      '/workspaces/workspace-1/services/web/logs?limit=200&runtimeInstanceId=runtime-1&afterSeq=2',
    )
    expect(queryClient.getQueryData<WorkspaceBackgroundServiceLogsResponse>(queryKey)?.entries)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ seq: 1, data: 'one\n' }),
        expect.objectContaining({ seq: 2, data: 'two\n' }),
        expect.objectContaining({ seq: 3, data: 'three\n' }),
      ]))

    await act(async () => {
      await queryClient.refetchQueries({ queryKey, exact: true })
    })
    expect(getMock).toHaveBeenNthCalledWith(
      3,
      '/workspaces/workspace-1/services/web/logs?limit=200&runtimeInstanceId=runtime-1&afterSeq=3',
    )
    expect(queryClient.getQueryData<WorkspaceBackgroundServiceLogsResponse>(queryKey)).toMatchObject({
      runtimeInstanceId: 'runtime-2',
      entries: [
        expect.objectContaining({ data: 'new-one\n' }),
        expect.objectContaining({ data: 'new-two\n' }),
        expect.objectContaining({ data: 'new-three\n' }),
      ],
      nextSeq: 4,
      reset: true,
    })

    await act(async () => {
      await queryClient.refetchQueries({ queryKey, exact: true })
    })
    expect(getMock).toHaveBeenNthCalledWith(
      4,
      '/workspaces/workspace-1/services/web/logs?limit=200&runtimeInstanceId=runtime-2&afterSeq=3',
    )
    expect(queryClient.getQueryData<WorkspaceBackgroundServiceLogsResponse>(queryKey)).toMatchObject({
      runtimeInstanceId: 'runtime-2',
      nextSeq: 5,
      reset: true,
    })
  })

  it.each([
    ['a new runtime', 'runtime-new'],
    ['no active runtime', null],
  ])('keeps the same cache when the service list changes from old to %s', async (_label, listedRuntime) => {
    getMock
      .mockResolvedValueOnce(response([
        { seq: 1, timestamp: '2026-07-31T00:00:00.000Z', data: 'old\n' },
      ], 2, { runtimeInstanceId: 'runtime-old' }))
      .mockResolvedValueOnce(response(
        listedRuntime === null
          ? []
          : [{ seq: 1, timestamp: '2026-07-31T00:00:01.000Z', data: 'new\n' }],
        listedRuntime === null ? 1 : 2,
        { runtimeInstanceId: listedRuntime, reset: true },
      ))

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe runtimeInstanceId="runtime-old" />
        </QueryClientProvider>,
      )
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    const queryKey = queryKeys.workspaceServices.logs('workspace-1', 'web')
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe runtimeInstanceId={listedRuntime} />
        </QueryClientProvider>,
      )
    })
    expect(queryClient.getQueryData<WorkspaceBackgroundServiceLogsResponse>(queryKey))
      .toMatchObject({ runtimeInstanceId: 'runtime-old', nextSeq: 2 })

    await act(async () => {
      await queryClient.refetchQueries({ queryKey, exact: true })
    })

    expect(getMock).toHaveBeenNthCalledWith(
      2,
      '/workspaces/workspace-1/services/web/logs?limit=200&runtimeInstanceId=runtime-old&afterSeq=1',
    )
    expect(queryClient.getQueryData<WorkspaceBackgroundServiceLogsResponse>(queryKey)).toMatchObject({
      runtimeInstanceId: listedRuntime,
      entries: listedRuntime === null ? [] : [expect.objectContaining({ data: 'new\n' })],
      reset: true,
    })
  })

  it('keeps paged logs when a stale service list catches up to the response generation', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      seq: index + 1,
      timestamp: '2026-07-31T00:00:00.000Z',
      data: `new-${index + 1}\n`,
    }))
    const finalPage = Array.from({ length: 50 }, (_, index) => ({
      seq: index + 201,
      timestamp: '2026-07-31T00:00:01.000Z',
      data: `new-${index + 201}\n`,
    }))
    getMock
      .mockResolvedValueOnce(response(firstPage, 201, {
        runtimeInstanceId: 'runtime-new',
        reset: true,
        hasMore: true,
      }))
      .mockResolvedValueOnce(response(finalPage, 251, { runtimeInstanceId: 'runtime-new' }))

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe runtimeInstanceId="runtime-old" />
        </QueryClientProvider>,
      )
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(getMock).toHaveBeenNthCalledWith(
      1,
      '/workspaces/workspace-1/services/web/logs?limit=200&runtimeInstanceId=runtime-old&afterSeq=0',
    )

    const queryKey = queryKeys.workspaceServices.logs('workspace-1', 'web')
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe runtimeInstanceId="runtime-new" />
        </QueryClientProvider>,
      )
      await queryClient.refetchQueries({ queryKey, exact: true })
    })

    expect(getMock).toHaveBeenNthCalledWith(
      2,
      '/workspaces/workspace-1/services/web/logs?limit=200&runtimeInstanceId=runtime-new&afterSeq=200',
    )
    expect(queryClient.getQueryData<WorkspaceBackgroundServiceLogsResponse>(queryKey)).toMatchObject({
      runtimeInstanceId: 'runtime-new',
      nextSeq: 251,
      reset: true,
      hasMore: false,
    })
    expect(queryClient.getQueryData<WorkspaceBackgroundServiceLogsResponse>(queryKey)?.entries)
      .toHaveLength(250)
  })

  it('does not restart the query while the service list changes rapidly', async () => {
    let resolveRequest!: (value: WorkspaceBackgroundServiceLogsResponse) => void
    getMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveRequest = resolve
    }))

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe runtimeInstanceId="runtime-old" />
        </QueryClientProvider>,
      )
    })
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe runtimeInstanceId="runtime-new" />
        </QueryClientProvider>,
      )
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe runtimeInstanceId={null} />
        </QueryClientProvider>,
      )
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe runtimeInstanceId="runtime-new" />
        </QueryClientProvider>,
      )
    })

    expect(getMock).toHaveBeenCalledTimes(1)
    expect(getMock).toHaveBeenCalledWith(
      '/workspaces/workspace-1/services/web/logs?limit=200&runtimeInstanceId=runtime-old&afterSeq=0',
    )

    await act(async () => {
      resolveRequest(response([
        { seq: 1, timestamp: '2026-07-31T00:00:00.000Z', data: 'new\n' },
      ], 2, { runtimeInstanceId: 'runtime-new', reset: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(queryClient.getQueryData<WorkspaceBackgroundServiceLogsResponse>(
      queryKeys.workspaceServices.logs('workspace-1', 'web'),
    )).toMatchObject({ runtimeInstanceId: 'runtime-new', nextSeq: 2, reset: true })
  })

  it('loads every backlog page when the service list is unavailable', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      seq: index + 1,
      timestamp: '2026-07-31T00:00:00.000Z',
      data: `line-${index + 1}\n`,
    }))
    const finalPage = Array.from({ length: 25 }, (_, index) => ({
      seq: index + 201,
      timestamp: '2026-07-31T00:00:01.000Z',
      data: `line-${index + 201}\n`,
    }))
    getMock
      .mockResolvedValueOnce(response(firstPage, 201, {
        runtimeInstanceId: 'runtime-live',
        hasMore: true,
      }))
      .mockResolvedValueOnce(response(finalPage, 226, { runtimeInstanceId: 'runtime-live' }))

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe runtimeInstanceId={null} />
        </QueryClientProvider>,
      )
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(getMock).toHaveBeenNthCalledWith(
      1,
      '/workspaces/workspace-1/services/web/logs?limit=200&afterSeq=0',
    )

    const queryKey = queryKeys.workspaceServices.logs('workspace-1', 'web')
    await act(async () => {
      await queryClient.refetchQueries({ queryKey, exact: true })
    })

    expect(getMock).toHaveBeenNthCalledWith(
      2,
      '/workspaces/workspace-1/services/web/logs?limit=200&runtimeInstanceId=runtime-live&afterSeq=200',
    )
    expect(queryClient.getQueryData<WorkspaceBackgroundServiceLogsResponse>(queryKey)).toMatchObject({
      runtimeInstanceId: 'runtime-live',
      nextSeq: 226,
      reset: false,
      hasMore: false,
    })
    expect(queryClient.getQueryData<WorkspaceBackgroundServiceLogsResponse>(queryKey)?.entries)
      .toHaveLength(225)
  })

  it.each([
    ['the same', 3],
    ['a larger', 6],
  ])('replaces old-generation entries when the new nextSeq has %s value', (_label, nextSeq) => {
    const current = response([
      { seq: 1, timestamp: '2026-07-31T00:00:00.000Z', data: 'old\n' },
    ], 3, { runtimeInstanceId: 'runtime-old' })
    const incoming = response([
      { seq: nextSeq - 1, timestamp: '2026-07-31T00:00:01.000Z', data: 'new\n' },
    ], nextSeq, { runtimeInstanceId: 'runtime-new' })

    const merged = mergeWorkspaceServiceLogs(current, incoming)

    expect(merged.runtimeInstanceId).toBe('runtime-new')
    expect(merged.entries.map(entry => entry.data)).toEqual(['new\n'])
    expect(merged.reset).toBe(true)
  })

  it('does not mark fully consumed backlog pages as truncated', () => {
    const current = response([
      { seq: 1, timestamp: '2026-07-31T00:00:00.000Z', data: 'one\n' },
    ], 2)
    const backlog = response(
      Array.from({ length: 200 }, (_, index) => ({
        seq: index + 2,
        timestamp: '2026-07-31T00:00:01.000Z',
        data: `line-${index}\n`,
      })),
      202,
      { hasMore: true },
    )
    const tail = response([
      { seq: 202, timestamp: '2026-07-31T00:00:02.000Z', data: 'tail\n' },
    ], 203)

    const caughtUp = mergeWorkspaceServiceLogs(mergeWorkspaceServiceLogs(current, backlog), tail)

    expect(caughtUp).toMatchObject({ truncated: false, reset: false, hasMore: false })
  })

  it('keeps accumulated browser logs bounded', () => {
    const incoming = response(
      Array.from({ length: 1_005 }, (_, index) => ({
        seq: index + 1,
        timestamp: '2026-07-31T00:00:00.000Z',
        data: `line-${index}\n`,
      })),
      1_006,
    )

    const merged = mergeWorkspaceServiceLogs(undefined, incoming)

    expect(merged.entries).toHaveLength(1_000)
    expect(merged.entries[0].seq).toBe(6)
    expect(merged.truncated).toBe(true)
  })
})
