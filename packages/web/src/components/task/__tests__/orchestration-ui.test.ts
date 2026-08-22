import { describe, expect, it } from 'vitest'
import { TaskOrchestrationStatus } from '@agent-tower/shared'
import {
  ORCHESTRATION_TRANSITIONS,
  directUserTransitionTargets,
  orchestrationStatusClass,
  orchestrationStatusLabel,
} from '../orchestration-model'

describe('task orchestration UI state model', () => {
  it('only exposes transitions accepted by the backend state machine', () => {
    expect(ORCHESTRATION_TRANSITIONS[TaskOrchestrationStatus.BACKLOG]).toEqual([
      TaskOrchestrationStatus.READY,
      TaskOrchestrationStatus.CANCELLED,
    ])
    expect(ORCHESTRATION_TRANSITIONS[TaskOrchestrationStatus.RUNNING]).toEqual([
      TaskOrchestrationStatus.WAITING_INPUT,
      TaskOrchestrationStatus.REVIEW,
      TaskOrchestrationStatus.BLOCKED,
      TaskOrchestrationStatus.HANDOFF,
      TaskOrchestrationStatus.RECOVERING,
      TaskOrchestrationStatus.CANCELLED,
    ])
    expect(ORCHESTRATION_TRANSITIONS[TaskOrchestrationStatus.MERGE_FAILED]).toEqual([
      TaskOrchestrationStatus.REVIEW,
      TaskOrchestrationStatus.HANDOFF,
      TaskOrchestrationStatus.RECOVERING,
      TaskOrchestrationStatus.CANCELLED,
    ])
  })

  it('provides readable labels and distinct operational severity styles', () => {
    expect(orchestrationStatusLabel(TaskOrchestrationStatus.RECOVERING)).toBe('Recovering')
    expect(orchestrationStatusLabel(TaskOrchestrationStatus.MERGE_FAILED)).toBe('Merge failed')
    expect(orchestrationStatusLabel(TaskOrchestrationStatus.WAITING_INPUT)).toBe('Waiting for input')
    expect(orchestrationStatusClass(TaskOrchestrationStatus.READY)).toContain('text-success')
    expect(orchestrationStatusClass(TaskOrchestrationStatus.RUNNING)).toContain('text-info')
    expect(orchestrationStatusClass(TaskOrchestrationStatus.WAITING_INPUT)).toContain('text-warning')
    expect(orchestrationStatusClass(TaskOrchestrationStatus.BLOCKED)).toContain('text-destructive')
  })

  it('routes readiness and assignment through their invariant-preserving endpoints', () => {
    expect(directUserTransitionTargets(TaskOrchestrationStatus.BACKLOG)).toEqual([
      TaskOrchestrationStatus.CANCELLED,
    ])
    expect(directUserTransitionTargets(TaskOrchestrationStatus.READY)).not.toContain(
      TaskOrchestrationStatus.ASSIGNED,
    )
    expect(directUserTransitionTargets(TaskOrchestrationStatus.BLOCKED)).not.toContain(
      TaskOrchestrationStatus.READY,
    )
  })
})
