import { TaskOrchestrationStatus } from '@agent-tower/shared'

export const ORCHESTRATION_TRANSITIONS: Record<
  TaskOrchestrationStatus,
  readonly TaskOrchestrationStatus[]
> = {
  [TaskOrchestrationStatus.BACKLOG]: [TaskOrchestrationStatus.READY, TaskOrchestrationStatus.CANCELLED],
  [TaskOrchestrationStatus.READY]: [TaskOrchestrationStatus.ASSIGNED, TaskOrchestrationStatus.BLOCKED, TaskOrchestrationStatus.CANCELLED],
  [TaskOrchestrationStatus.ASSIGNED]: [TaskOrchestrationStatus.RUNNING, TaskOrchestrationStatus.READY, TaskOrchestrationStatus.HANDOFF, TaskOrchestrationStatus.RECOVERING, TaskOrchestrationStatus.CANCELLED],
  [TaskOrchestrationStatus.RUNNING]: [TaskOrchestrationStatus.WAITING_INPUT, TaskOrchestrationStatus.REVIEW, TaskOrchestrationStatus.BLOCKED, TaskOrchestrationStatus.HANDOFF, TaskOrchestrationStatus.RECOVERING, TaskOrchestrationStatus.CANCELLED],
  [TaskOrchestrationStatus.WAITING_INPUT]: [TaskOrchestrationStatus.READY, TaskOrchestrationStatus.CANCELLED],
  [TaskOrchestrationStatus.REVIEW]: [TaskOrchestrationStatus.RUNNING, TaskOrchestrationStatus.MERGING, TaskOrchestrationStatus.DONE, TaskOrchestrationStatus.MERGE_FAILED, TaskOrchestrationStatus.CANCELLED],
  [TaskOrchestrationStatus.MERGING]: [TaskOrchestrationStatus.DONE, TaskOrchestrationStatus.MERGE_FAILED, TaskOrchestrationStatus.RECOVERING],
  [TaskOrchestrationStatus.DONE]: [TaskOrchestrationStatus.REVIEW, TaskOrchestrationStatus.CANCELLED],
  [TaskOrchestrationStatus.BLOCKED]: [TaskOrchestrationStatus.READY, TaskOrchestrationStatus.HANDOFF, TaskOrchestrationStatus.CANCELLED],
  [TaskOrchestrationStatus.HANDOFF]: [TaskOrchestrationStatus.READY, TaskOrchestrationStatus.ASSIGNED, TaskOrchestrationStatus.CANCELLED],
  [TaskOrchestrationStatus.RECOVERING]: [TaskOrchestrationStatus.READY, TaskOrchestrationStatus.ASSIGNED, TaskOrchestrationStatus.HANDOFF, TaskOrchestrationStatus.CANCELLED],
  [TaskOrchestrationStatus.MERGE_FAILED]: [TaskOrchestrationStatus.REVIEW, TaskOrchestrationStatus.HANDOFF, TaskOrchestrationStatus.RECOVERING, TaskOrchestrationStatus.CANCELLED],
  [TaskOrchestrationStatus.CANCELLED]: [TaskOrchestrationStatus.BACKLOG, TaskOrchestrationStatus.READY],
}

/** READY must pass dependency checks; ASSIGNED must acquire a worker lease. */
export function directUserTransitionTargets(status: TaskOrchestrationStatus) {
  return ORCHESTRATION_TRANSITIONS[status].filter((nextStatus) => (
    nextStatus !== TaskOrchestrationStatus.READY
    && nextStatus !== TaskOrchestrationStatus.ASSIGNED
    && nextStatus !== TaskOrchestrationStatus.WAITING_INPUT
  ))
}

export function orchestrationStatusLabel(status: TaskOrchestrationStatus): string {
  switch (status) {
    case TaskOrchestrationStatus.BACKLOG: return 'Backlog'
    case TaskOrchestrationStatus.READY: return 'Ready'
    case TaskOrchestrationStatus.ASSIGNED: return 'Assigned'
    case TaskOrchestrationStatus.RUNNING: return 'Running'
    case TaskOrchestrationStatus.WAITING_INPUT: return 'Waiting for input'
    case TaskOrchestrationStatus.REVIEW: return 'Review'
    case TaskOrchestrationStatus.MERGING: return 'Merging'
    case TaskOrchestrationStatus.DONE: return 'Done'
    case TaskOrchestrationStatus.BLOCKED: return 'Blocked'
    case TaskOrchestrationStatus.HANDOFF: return 'Handoff'
    case TaskOrchestrationStatus.RECOVERING: return 'Recovering'
    case TaskOrchestrationStatus.MERGE_FAILED: return 'Merge failed'
    case TaskOrchestrationStatus.CANCELLED: return 'Cancelled'
  }
}

export function orchestrationStatusClass(status: TaskOrchestrationStatus): string {
  switch (status) {
    case TaskOrchestrationStatus.READY:
    case TaskOrchestrationStatus.DONE:
      return 'bg-success/10 text-success border-success/20'
    case TaskOrchestrationStatus.ASSIGNED:
    case TaskOrchestrationStatus.RUNNING:
      return 'bg-info/10 text-info border-info/20'
    case TaskOrchestrationStatus.REVIEW:
    case TaskOrchestrationStatus.WAITING_INPUT:
    case TaskOrchestrationStatus.MERGING:
    case TaskOrchestrationStatus.RECOVERING:
      return 'bg-warning/10 text-warning border-warning/20'
    case TaskOrchestrationStatus.BLOCKED:
    case TaskOrchestrationStatus.MERGE_FAILED:
      return 'bg-destructive/10 text-destructive border-destructive/20'
    default:
      return 'bg-muted/60 text-muted-foreground border-border'
  }
}
