import type { WorkspaceBackgroundServiceDto } from '@agent-tower/shared'
import { ApiError } from './api-client'

const MERGE_BLOCKING_SERVICE_STATES = new Set(['STARTING', 'RUNNING', 'STOPPING'])

export function isMergeBlockingWorkspaceService(service: WorkspaceBackgroundServiceDto) {
  return MERGE_BLOCKING_SERVICE_STATES.has(service.runtimeState)
    || service.runtimeInstanceId !== null
}

export function isWorkspaceServiceMergeError(error: unknown) {
  return error instanceof ApiError
    && error.status === 409
    && error.details.code === 'WORKSPACE_HAS_ACTIVE_SERVICE'
}
