import { describe, expect, it } from 'vitest'
import type { Project } from '@agent-tower/shared'
import { sortProjectsByActivity } from '@/lib/project-activity'

function project(id: string, createdAt: string, lastActivityAt?: string): Project {
  return {
    id,
    name: id,
    color: 'text-indigo-600',
    repoPath: `/tmp/${id}`,
    mainBranch: 'main',
    createdAt,
    lastActivityAt,
  }
}

describe('sortProjectsByActivity', () => {
  it('places projects with the most recent backend task creation time first', () => {
    const projects = [
      project('older', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
      project('active', '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z'),
      project('empty', '2026-01-02T00:00:00.000Z'),
    ]

    const sorted = sortProjectsByActivity(projects)

    expect(sorted.map(item => item.id)).toEqual(['active', 'older', 'empty'])
  })

  it('uses project creation time for projects without tasks and as a tie-breaker', () => {
    const projects = [
      project('first', '2026-01-01T00:00:00.000Z'),
      project('second', '2026-01-02T00:00:00.000Z'),
    ]

    expect(sortProjectsByActivity(projects).map(item => item.id)).toEqual(['second', 'first'])
    const tiedProjects = projects.map(item => ({
      ...item,
      lastActivityAt: '2026-01-03T00:00:00.000Z',
    }))
    expect(sortProjectsByActivity(tiedProjects).map(item => item.id)).toEqual(['second', 'first'])
  })
})
