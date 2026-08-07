import { describe, expect, it } from 'vitest'
import type { WorkspaceBackgroundServiceDto } from '@agent-tower/shared'
import { ApiError } from '@/lib/api-client'
import {
  isMergeBlockingWorkspaceService,
  isWorkspaceServiceMergeError,
} from '@/lib/workspace-merge'

function service(
  runtimeState: WorkspaceBackgroundServiceDto['runtimeState'],
  runtimeInstanceId: string | null = null,
): WorkspaceBackgroundServiceDto {
  return {
    id: 'service-1',
    workspaceId: 'workspace-1',
    name: 'web',
    command: 'pnpm',
    args: ['dev'],
    relativeCwd: '.',
    desiredState: 'RUNNING',
    runtimeState,
    runtimeInstanceId,
    pid: null,
    exitCode: null,
    lastError: null,
    startedAt: null,
    stoppedAt: null,
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
  }
}

describe('workspace merge background service state', () => {
  it.each(['STARTING', 'RUNNING', 'STOPPING'] as const)(
    'treats %s services as merge blocking',
    (runtimeState) => {
      expect(isMergeBlockingWorkspaceService(service(runtimeState))).toBe(true)
    },
  )

  it('treats a retained runtime identity as merge blocking', () => {
    expect(isMergeBlockingWorkspaceService(service('FAILED', 'runtime-still-owned'))).toBe(true)
    expect(isMergeBlockingWorkspaceService(service('FAILED'))).toBe(false)
  })

  it('recognizes only the structured active-service merge error', () => {
    expect(isWorkspaceServiceMergeError(new ApiError(409, 'blocked', {
      code: 'WORKSPACE_HAS_ACTIVE_SERVICE',
    }))).toBe(true)
    expect(isWorkspaceServiceMergeError(new ApiError(409, 'conflict', {
      code: 'MERGE_CONFLICT',
    }))).toBe(false)
  })
})
