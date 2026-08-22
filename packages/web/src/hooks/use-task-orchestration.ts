import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  TaskOrchestrationStatus,
  type Task,
  type TaskDependency,
  type TaskDependencyResponse,
  type TaskEvent,
  type TaskHumanInputAnswerResult,
  type TaskReadinessResponse,
  type TaskWorkflowListResponse,
} from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'

interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
}

export interface TransitionTaskOrchestrationInput {
  taskId: string
  projectId: string
  status: TaskOrchestrationStatus
  reason?: string
}

interface TaskWorkerInput {
  taskId: string
  projectId: string
  workerId: string
}

interface AddTaskDependencyInput {
  taskId: string
  projectId: string
  dependsOnTaskId: string
}

type RemoveTaskDependencyInput = AddTaskDependencyInput

interface AnswerTaskHumanInputInput {
  teamRunId: string
  rootTaskId: string
  runId: string
  taskId: string
  questionId: string
  projectId: string
  answer: string
}

export function invalidateTaskOrchestration(
  queryClient: QueryClient,
  taskId?: string,
  projectId?: string,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.tasks.orchestrationAll })
  queryClient.invalidateQueries({ queryKey: queryKeys.tasks.boardAll })
  if (taskId) {
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) })
  }
  if (projectId) {
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.dependencyCandidates(projectId) })
  }
}

export function useTaskDependencies(taskId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tasks.dependencies(taskId),
    queryFn: () => apiClient.get<TaskDependencyResponse>(`/tasks/${taskId}/dependencies`),
    enabled: Boolean(taskId) && enabled,
  })
}

export function useTaskReadiness(taskId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tasks.readiness(taskId),
    queryFn: () => apiClient.get<TaskReadinessResponse>(`/tasks/${taskId}/readiness`),
    enabled: Boolean(taskId) && enabled,
  })
}

export function useTaskEvents(taskId: string, limit = 200, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tasks.events(taskId),
    queryFn: () => apiClient.get<TaskEvent[]>(`/tasks/${taskId}/events`, {
      params: { limit: String(limit) },
    }),
    enabled: Boolean(taskId) && enabled,
  })
}

export function useTaskWorkflows(taskId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tasks.workflows(taskId),
    queryFn: () => apiClient.get<TaskWorkflowListResponse>(`/tasks/${taskId}/workflows`),
    enabled: Boolean(taskId) && enabled,
  })
}

export function useDependencyCandidates(projectId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tasks.dependencyCandidates(projectId),
    queryFn: () => apiClient.get<PaginatedResponse<Task>>(`/projects/${projectId}/tasks`, {
      params: { page: '1', limit: '1000' },
    }),
    enabled: Boolean(projectId) && enabled,
  })
}

export function useAddTaskDependency() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, dependsOnTaskId }: AddTaskDependencyInput) =>
      apiClient.post<TaskDependency>(`/tasks/${taskId}/dependencies`, { dependsOnTaskId }),
    onSuccess: (_data, input) => {
      invalidateTaskOrchestration(queryClient, input.taskId, input.projectId)
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.readiness(input.dependsOnTaskId) })
    },
  })
}

export function useRemoveTaskDependency() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, dependsOnTaskId }: RemoveTaskDependencyInput) =>
      apiClient.delete<void>(`/tasks/${taskId}/dependencies/${dependsOnTaskId}`),
    onSuccess: (_data, input) => {
      invalidateTaskOrchestration(queryClient, input.taskId, input.projectId)
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.readiness(input.dependsOnTaskId) })
    },
  })
}

export function useMarkTaskReady() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId }: { taskId: string; projectId: string }) =>
      apiClient.post<Task>(`/tasks/${taskId}/orchestration/ready`, {}),
    onSuccess: (_data, input) => {
      invalidateTaskOrchestration(queryClient, input.taskId, input.projectId)
    },
  })
}

export function useTransitionTaskOrchestration() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: TransitionTaskOrchestrationInput) =>
      apiClient.patch<Task>(`/tasks/${input.taskId}/orchestration`, {
        status: input.status,
        reason: input.reason,
        actorType: 'USER',
      }),
    onSuccess: (_data, input) => {
      invalidateTaskOrchestration(queryClient, input.taskId, input.projectId)
    },
  })
}

export function useClaimTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, workerId }: TaskWorkerInput) =>
      apiClient.post<Task>(`/tasks/${taskId}/orchestration/claim`, { workerId }),
    onSuccess: (_data, input) => {
      invalidateTaskOrchestration(queryClient, input.taskId, input.projectId)
    },
  })
}

export function useHeartbeatTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, workerId }: TaskWorkerInput) =>
      apiClient.post<Task>(`/tasks/${taskId}/orchestration/heartbeat`, { workerId }),
    onSuccess: (_data, input) => {
      invalidateTaskOrchestration(queryClient, input.taskId, input.projectId)
    },
  })
}

export function useAnswerTaskHumanInput() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AnswerTaskHumanInputInput) =>
      apiClient.post<TaskHumanInputAnswerResult>(
        `/team-runs/${input.teamRunId}/workflows/${encodeURIComponent(input.runId)}/nodes/${input.taskId}/human-input/${encodeURIComponent(input.questionId)}/answer`,
        { answer: input.answer },
      ),
    onSuccess: (_data, input) => {
      invalidateTaskOrchestration(queryClient, input.taskId, input.projectId)
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.workflows(input.rootTaskId) })
      queryClient.invalidateQueries({ queryKey: ['team-runs'] })
    },
  })
}
