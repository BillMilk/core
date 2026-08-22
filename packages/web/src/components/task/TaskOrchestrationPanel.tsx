import { useMemo, useState } from 'react'
import { TaskOrchestrationStatus, type TaskDependency, type TaskEvent } from '@agent-tower/shared'
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  Clock3,
  GitBranch,
  Link2,
  Loader2,
  MessageCircleQuestion,
  RefreshCw,
  Unlink,
  UserRound,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  useAddTaskDependency,
  useAnswerTaskHumanInput,
  useClaimTask,
  useDependencyCandidates,
  useHeartbeatTask,
  useMarkTaskReady,
  useRemoveTaskDependency,
  useTaskDependencies,
  useTaskEvents,
  useTaskWorkflows,
  useTaskReadiness,
  useTransitionTaskOrchestration,
} from '@/hooks/use-task-orchestration'
import { useTask } from '@/hooks/use-tasks'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  OrchestrationStatusBadge,
} from './orchestration-ui'
import {
  ORCHESTRATION_TRANSITIONS,
  directUserTransitionTargets,
  orchestrationStatusLabel,
} from './orchestration-model'

interface TaskOrchestrationPanelProps {
  taskId: string
  projectId: string
  orchestrationStatus?: TaskOrchestrationStatus
  teamRunId?: string
  readOnly?: boolean
  compact?: boolean
  onOpenTask?: (taskId: string) => void
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatTimestamp(value: string | null | undefined, locale: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function asOrchestrationStatus(value: string | null | undefined) {
  return Object.values(TaskOrchestrationStatus).includes(value as TaskOrchestrationStatus)
    ? value as TaskOrchestrationStatus
    : null
}

function dependencyTask(edge: TaskDependency, kind: 'prerequisite' | 'dependent') {
  return kind === 'prerequisite' ? edge.dependsOnTask : edge.task
}

function eventLabel(type: string) {
  const labels: Record<string, string> = {
    'task.created': 'Task created',
    'task.updated': 'Task updated',
    'task.status_changed': 'Status changed',
    'task.dependency_added': 'Dependency added',
    'task.dependency_removed': 'Dependency removed',
    'task.claimed': 'Task claimed',
    'task.started': 'Task started',
    'task.released': 'Task released',
    'task.recovered': 'Task recovered',
    'task.completed': 'Task completed',
    'task.failed': 'Task failed',
    'task.deleted': 'Task deleted',
    'workflow.initialized': 'Workflow initialized',
    'workflow.node_created': 'Workflow node created',
    'workflow.completed': 'Workflow completed',
    'task.human_input_requested': 'Human input requested',
    'task.human_input_answered': 'Human input answered',
  }
  return labels[type] ?? type
}

function payloadSummary(payload: unknown) {
  if (payload == null) return null
  if (typeof payload === 'string') return payload
  try {
    const serialized = JSON.stringify(payload)
    return serialized.length > 240 ? `${serialized.slice(0, 237)}...` : serialized
  } catch {
    return String(payload)
  }
}

function DependencyList({
  dependencies,
  kind,
  removingId,
  readOnly,
  onRemove,
}: {
  dependencies: TaskDependency[]
  kind: 'prerequisite' | 'dependent'
  removingId?: string
  readOnly?: boolean
  onRemove?: (taskId: string) => void
}) {
  const { t } = useI18n()
  if (dependencies.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        {t(kind === 'prerequisite' ? 'No prerequisites' : 'No dependents')}
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      {dependencies.map((edge) => {
        const relatedTask = dependencyTask(edge, kind)
        const relatedId = kind === 'prerequisite' ? edge.dependsOnTaskId : edge.taskId
        return (
          <div key={edge.id} className="flex min-w-0 items-center gap-2 rounded-md border bg-background px-2.5 py-2">
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs" title={relatedTask?.title ?? relatedId}>
              {relatedTask?.title ?? relatedId}
            </span>
            <OrchestrationStatusBadge status={relatedTask?.orchestrationStatus} compact />
            {kind === 'prerequisite' && onRemove && !readOnly && (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                title={t('Remove dependency')}
                disabled={removingId === relatedId}
                onClick={() => onRemove(relatedId)}
              >
                {removingId === relatedId ? <Loader2 className="animate-spin" /> : <Unlink />}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function TaskOrchestrationPanel({
  taskId,
  projectId,
  orchestrationStatus,
  teamRunId,
  readOnly = false,
  compact = false,
  onOpenTask,
}: TaskOrchestrationPanelProps) {
  const { t, locale } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [dependencyId, setDependencyId] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [reason, setReason] = useState('')
  const [humanAnswers, setHumanAnswers] = useState<Record<string, string>>({})

  const taskQuery = useTask(taskId, true)
  const dependenciesQuery = useTaskDependencies(taskId, expanded)
  const readinessQuery = useTaskReadiness(taskId, expanded)
  const eventsQuery = useTaskEvents(taskId, 200, expanded)
  const workflowsQuery = useTaskWorkflows(taskId, true)
  const candidatesQuery = useDependencyCandidates(projectId, expanded && !readOnly)
  const addDependency = useAddTaskDependency()
  const removeDependency = useRemoveTaskDependency()
  const markReady = useMarkTaskReady()
  const transition = useTransitionTaskOrchestration()
  const claimTask = useClaimTask()
  const heartbeatTask = useHeartbeatTask()
  const answerHumanInput = useAnswerTaskHumanInput()

  const task = taskQuery.data
  const resolvedTeamRunId = teamRunId ?? task?.teamRun?.id
  const status = task?.orchestrationStatus ?? orchestrationStatus ?? TaskOrchestrationStatus.BACKLOG
  const prerequisites = useMemo(
    () => dependenciesQuery.data?.prerequisites ?? [],
    [dependenciesQuery.data?.prerequisites],
  )
  const dependents = dependenciesQuery.data?.dependents ?? []
  const blockers = readinessQuery.data?.blockers ?? []
  const isReady = readinessQuery.data?.ready ?? false
  const transitions = ORCHESTRATION_TRANSITIONS[status]
  const pendingHumanInputs = useMemo(() => (
    (workflowsQuery.data?.workflows ?? []).flatMap((workflow) => (
      workflow.nodes.flatMap((node) => (
        node.humanInput?.status === 'WAITING'
          ? [{ workflow, node, humanInput: node.humanInput }]
          : []
      ))
    ))
  ), [workflowsQuery.data?.workflows])
  const isLoading = taskQuery.isLoading || dependenciesQuery.isLoading || readinessQuery.isLoading
  const refreshPending = taskQuery.isFetching || dependenciesQuery.isFetching || readinessQuery.isFetching || eventsQuery.isFetching || workflowsQuery.isFetching

  const candidateTasks = useMemo(() => {
    const excluded = new Set<string>([taskId, ...prerequisites.map((edge) => edge.dependsOnTaskId)])
    return (candidatesQuery.data?.data ?? []).filter((candidate) => !excluded.has(candidate.id))
  }, [candidatesQuery.data?.data, prerequisites, taskId])

  const refresh = () => {
    void Promise.all([
      taskQuery.refetch(),
      dependenciesQuery.refetch(),
      readinessQuery.refetch(),
      eventsQuery.refetch(),
      workflowsQuery.refetch(),
      candidatesQuery.refetch(),
    ])
  }

  const submitDependency = () => {
    if (!dependencyId) return
    addDependency.mutate(
      { taskId, projectId, dependsOnTaskId: dependencyId },
      {
        onSuccess: () => {
          setDependencyId('')
          toast.success(t('Dependency added'))
        },
        onError: (error) => toast.error(getErrorMessage(error)),
      },
    )
  }

  const submitTransition = (nextStatus: TaskOrchestrationStatus) => {
    transition.mutate(
      { taskId, projectId, status: nextStatus, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setReason('')
          toast.success(t('Orchestration status updated'))
        },
        onError: (error) => toast.error(getErrorMessage(error)),
      },
    )
  }

  const worker = workerId.trim() || task?.orchestrationClaimedBy || ''

  return (
    <section className={cn('border-b bg-muted/20', compact ? 'px-3 py-2' : 'px-5 py-2.5')}>
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Activity className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">{t('Orchestration')}</span>
        <OrchestrationStatusBadge status={status} compact />
        {blockers.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
            <AlertTriangle className="size-3" />
            {t('{count} blockers', { count: blockers.length })}
          </span>
        ) : isReady ? (
          <span className="text-[11px] text-success">{t('Ready to claim')}</span>
        ) : null}
        {pendingHumanInputs.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] text-warning">
            <MessageCircleQuestion className="size-3" />
            {t('{count} awaiting your input', { count: pendingHumanInputs.length })}
          </span>
        )}
        {task?.orchestrationClaimedBy && (
          <span className="ml-auto max-w-44 truncate text-[11px] text-muted-foreground">
            {t('Worker')}: {task.orchestrationClaimedBy}
          </span>
        )}
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180', !task?.orchestrationClaimedBy && 'ml-auto')} />
      </button>

      {expanded && (
        <div className={cn('mt-3 space-y-4 overflow-y-auto pr-1', compact ? 'max-h-[48vh]' : 'max-h-[56vh]')}>
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-md border bg-background p-3">
                  <div className="text-[11px] text-muted-foreground">{t('Readiness')}</div>
                  <div className={cn('mt-1 text-sm font-medium', blockers.length ? 'text-destructive' : isReady ? 'text-success' : '')}>
                    {blockers.length ? t('Blocked by {count} dependencies', { count: blockers.length }) : isReady ? t('Ready to claim') : t('Waiting for state transition')}
                  </div>
                </div>
                <div className="rounded-md border bg-background p-3">
                  <div className="text-[11px] text-muted-foreground">{t('Worker')} / {t('Attempts')}</div>
                  <div className="mt-1 truncate text-sm font-medium">{task?.orchestrationClaimedBy || t('Unassigned')} · {task?.orchestrationAttemptCount ?? 0}</div>
                </div>
                <div className="rounded-md border bg-background p-3">
                  <div className="text-[11px] text-muted-foreground">{t('Last heartbeat')} / {t('Claimed')}</div>
                  <div className="mt-1 text-xs">{formatTimestamp(task?.orchestrationHeartbeatAt, locale)} / {formatTimestamp(task?.orchestrationClaimedAt, locale)}</div>
                </div>
                <div className="rounded-md border bg-background p-3">
                  <div className="text-[11px] text-muted-foreground">{t('Last error')}</div>
                  <div className={cn('mt-1 line-clamp-2 text-xs', task?.orchestrationLastError && 'text-destructive')} title={task?.orchestrationLastError ?? undefined}>
                    {task?.orchestrationLastError || t('No error recorded')}
                  </div>
                </div>
              </div>

              {pendingHumanInputs.length > 0 && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
                  <div className="mb-3">
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold text-warning">
                      <MessageCircleQuestion className="size-3.5" />
                      {t('Waiting for your input')}
                    </h3>
                    <p className="text-[11px] text-muted-foreground">
                      {t('Only dependent branches are paused. Other ready DAG branches continue running.')}
                    </p>
                  </div>
                  <div className="space-y-3">
                    {pendingHumanInputs.map(({ workflow, node, humanInput }) => {
                      const answer = humanAnswers[humanInput.questionId] ?? ''
                      const isSubmitting = answerHumanInput.isPending
                        && answerHumanInput.variables?.questionId === humanInput.questionId
                      return (
                        <div key={humanInput.questionId} className="rounded-md border bg-background p-3">
                          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                            <span className="font-mono">{workflow.runId} / {node.key}</span>
                            <OrchestrationStatusBadge status={TaskOrchestrationStatus.WAITING_INPUT} compact />
                          </div>
                          <p className="mt-2 text-sm font-medium">{humanInput.question}</p>
                          {humanInput.context && (
                            <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{humanInput.context}</p>
                          )}
                          {humanInput.options.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {humanInput.options.map((option) => (
                                <Button
                                  key={option}
                                  type="button"
                                  size="xs"
                                  variant={answer === option ? 'default' : 'outline'}
                                  disabled={readOnly || isSubmitting}
                                  onClick={() => setHumanAnswers((current) => ({ ...current, [humanInput.questionId]: option }))}
                                >
                                  {option}
                                </Button>
                              ))}
                            </div>
                          )}
                          {humanInput.allowFreeText && (
                            <Textarea
                              className="mt-2 min-h-20 bg-background text-xs"
                              value={answer}
                              disabled={readOnly || isSubmitting}
                              placeholder={t('Enter your answer for this DAG node')}
                              onChange={(event) => setHumanAnswers((current) => ({
                                ...current,
                                [humanInput.questionId]: event.target.value,
                              }))}
                            />
                          )}
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <span className="text-[10px] text-muted-foreground">
                              {t('The answer is recorded in TaskEvent and the exact node resumes automatically.')}
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              disabled={readOnly || !resolvedTeamRunId || !answer.trim() || isSubmitting}
                              onClick={() => {
                                if (!resolvedTeamRunId) return
                                answerHumanInput.mutate({
                                  teamRunId: resolvedTeamRunId,
                                  rootTaskId: taskId,
                                  runId: workflow.runId,
                                  taskId: node.task.id,
                                  questionId: humanInput.questionId,
                                  projectId,
                                  answer: answer.trim(),
                                }, {
                                  onSuccess: () => {
                                    setHumanAnswers((current) => {
                                      const next = { ...current }
                                      delete next[humanInput.questionId]
                                      return next
                                    })
                                    toast.success(t('Answer submitted; the DAG node is ready to resume'))
                                  },
                                  onError: (error) => toast.error(getErrorMessage(error)),
                                })
                              }}
                            >
                              {isSubmitting && <Loader2 className="animate-spin" />}
                              {t('Submit answer and continue')}
                            </Button>
                          </div>
                          {!resolvedTeamRunId && (
                            <p className="mt-2 text-xs text-destructive">{t('Open the TeamRun root task to answer this question.')}</p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {(workflowsQuery.data?.workflows.length ?? 0) > 0 && (
                <div className="rounded-lg border bg-background p-3">
                  <div className="mb-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold"><GitBranch className="size-3.5" />{t('Task workflows')}</h3>
                    <p className="text-[11px] text-muted-foreground">{t('Durable DAG runs rooted at this task.')}</p>
                  </div>
                  <div className="space-y-3">
                    {workflowsQuery.data?.workflows.map((workflow) => (
                      <div key={workflow.runId} className="rounded-md border p-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium">{workflow.runId}</span>
                          <span className="text-[10px] text-muted-foreground">{t('{count} nodes', { count: workflow.nodes.length })}</span>
                          <div className="ml-auto flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                            {Object.entries(workflow.counts).map(([workflowStatus, count]) => (
                              <span key={workflowStatus} className="rounded border px-1.5 py-0.5">{workflowStatus}: {count}</span>
                            ))}
                          </div>
                        </div>
                        <div className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                          {workflow.nodes.map((node) => (
                            <button
                              key={node.task.id}
                              type="button"
                              className={cn(
                                'flex min-w-0 items-center gap-2 rounded border px-2 py-1.5 text-left',
                                onOpenTask ? 'hover:bg-muted' : 'cursor-default',
                              )}
                              title={`${node.key} · ${node.role}\n${node.task.title}`}
                              onClick={() => onOpenTask?.(node.task.id)}
                            >
                              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{node.key}</span>
                              <span className="min-w-0 flex-1 truncate text-[11px]">{node.task.title}</span>
                              <OrchestrationStatusBadge status={node.task.orchestrationStatus} compact />
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!readOnly && (
                <div className="rounded-lg border bg-background p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold">{t('Orchestration controls')}</h3>
                      <p className="text-[11px] text-muted-foreground">{t('Only transitions allowed by the backend state machine are shown.')}</p>
                    </div>
                    <Button type="button" size="xs" variant="ghost" onClick={refresh} disabled={refreshPending}>
                      <RefreshCw className={cn(refreshPending && 'animate-spin')} /> {t('Refresh')}
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {status !== TaskOrchestrationStatus.WAITING_INPUT
                      && transitions.includes(TaskOrchestrationStatus.READY) && (
                      <Button
                        type="button"
                        size="xs"
                        disabled={markReady.isPending}
                        onClick={() => markReady.mutate({ taskId, projectId }, {
                          onSuccess: () => toast.success(t('Task marked ready')),
                          onError: (error) => toast.error(getErrorMessage(error)),
                        })}
                      >
                        {markReady.isPending && <Loader2 className="animate-spin" />} {t('Mark ready')}
                      </Button>
                    )}
                    {directUserTransitionTargets(status)
                      .map((nextStatus) => (
                        <Button
                          key={nextStatus}
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={transition.isPending}
                          onClick={() => submitTransition(nextStatus)}
                        >
                          {t('Move to {status}', { status: t(orchestrationStatusLabel(nextStatus)) })}
                        </Button>
                      ))}
                  </div>
                  <Input
                    className="mt-2 h-8 text-xs"
                    value={reason}
                    placeholder={t('Reason (optional)')}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  {(status === TaskOrchestrationStatus.READY || status === TaskOrchestrationStatus.RECOVERING) && (
                    <div className="mt-2 flex gap-2">
                      <Input className="h-8 text-xs" value={workerId} placeholder={t('Worker ID')} onChange={(event) => setWorkerId(event.target.value)} />
                      <Button
                        type="button"
                        size="sm"
                        disabled={!workerId.trim() || claimTask.isPending}
                        onClick={() => claimTask.mutate({ taskId, projectId, workerId: workerId.trim() }, {
                          onSuccess: () => toast.success(t('Task claimed')),
                          onError: (error) => toast.error(getErrorMessage(error)),
                        })}
                      >
                        <UserRound /> {t('Claim task')}
                      </Button>
                    </div>
                  )}
                  {worker && (status === TaskOrchestrationStatus.ASSIGNED || status === TaskOrchestrationStatus.RUNNING) && (
                    <Button
                      className="mt-2"
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={heartbeatTask.isPending}
                      onClick={() => heartbeatTask.mutate({ taskId, projectId, workerId: worker }, {
                        onSuccess: () => toast.success(t('Heartbeat sent')),
                        onError: (error) => toast.error(getErrorMessage(error)),
                      })}
                    >
                      <Activity /> {t('Send heartbeat')}
                    </Button>
                  )}
                </div>
              )}

              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-lg border bg-background p-3">
                  <div className="mb-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold"><Link2 className="size-3.5" />{t('Prerequisites')}</h3>
                    <p className="text-[11px] text-muted-foreground">{t('This task waits for these tasks to finish.')}</p>
                  </div>
                  {!readOnly && (
                    <div className="mb-2 flex gap-2">
                      <select
                        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
                        value={dependencyId}
                        onChange={(event) => setDependencyId(event.target.value)}
                      >
                        <option value="">{t('Select a task')}</option>
                        {candidateTasks.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
                      </select>
                      <Button type="button" size="sm" disabled={!dependencyId || addDependency.isPending} onClick={submitDependency}>
                        {addDependency.isPending ? <Loader2 className="animate-spin" /> : <Link2 />} {t('Add')}
                      </Button>
                    </div>
                  )}
                  <DependencyList
                    dependencies={prerequisites}
                    kind="prerequisite"
                    readOnly={readOnly}
                    removingId={removeDependency.variables?.dependsOnTaskId}
                    onRemove={(dependsOnTaskId) => removeDependency.mutate({ taskId, projectId, dependsOnTaskId }, {
                      onSuccess: () => toast.success(t('Dependency removed')),
                      onError: (error) => toast.error(getErrorMessage(error)),
                    })}
                  />
                </div>
                <div className="rounded-lg border bg-background p-3">
                  <div className="mb-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold"><GitBranch className="size-3.5" />{t('Dependents')}</h3>
                    <p className="text-[11px] text-muted-foreground">{t('These tasks are waiting for this task.')}</p>
                  </div>
                  <DependencyList dependencies={dependents} kind="dependent" readOnly />
                </div>
              </div>

              <div className="rounded-lg border bg-background p-3">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold"><Clock3 className="size-3.5" />{t('Orchestration activity')}</h3>
                    <p className="text-[11px] text-muted-foreground">{t('Durable task events recorded by the backend.')}</p>
                  </div>
                  {eventsQuery.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                </div>
                {(eventsQuery.data?.length ?? 0) === 0 ? (
                  <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">{t('No orchestration events yet')}</p>
                ) : (
                  <ol className="space-y-2">
                    {[...(eventsQuery.data ?? [])].reverse().map((event: TaskEvent) => {
                      const from = asOrchestrationStatus(event.fromStatus)
                      const to = asOrchestrationStatus(event.toStatus)
                      const payload = payloadSummary(event.payload)
                      return (
                        <li key={event.id} className="rounded-md border px-3 py-2 text-xs">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium">{t(eventLabel(event.type))}</span>
                            {from && <OrchestrationStatusBadge status={from} compact />}
                            {from && to && <span className="text-muted-foreground">→</span>}
                            {to && <OrchestrationStatusBadge status={to} compact />}
                            <time className="ml-auto text-[10px] text-muted-foreground">{formatTimestamp(event.createdAt, locale)}</time>
                          </div>
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            {event.actorType}{event.actorId ? ` · ${event.actorId}` : ''}
                          </div>
                          {payload && <code className="mt-1 block break-all rounded bg-muted px-1.5 py-1 text-[10px] text-muted-foreground">{payload}</code>}
                        </li>
                      )
                    })}
                  </ol>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
