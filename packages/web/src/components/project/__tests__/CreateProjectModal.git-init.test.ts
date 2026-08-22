import { describe, expect, it } from 'vitest'
import { requiresGitInitializationConfirmation } from '../CreateProjectModal'

describe('CreateProjectModal Git initialization decision', () => {
  it('asks before adding either an empty or non-empty non-Git directory', () => {
    expect(requiresGitInitializationConfirmation({
      valid: true,
      reason: 'no_git',
      isGitRepo: false,
    })).toBe(true)
  })

  it('creates an existing Git repository without the initialization prompt', () => {
    expect(requiresGitInitializationConfirmation({
      valid: true,
      isGitRepo: true,
    })).toBe(false)
  })
})
