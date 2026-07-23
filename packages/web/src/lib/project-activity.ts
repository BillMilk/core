import type { Project } from '@agent-tower/shared'

function parseTime(value?: string): number {
  if (!value) return 0
  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

/** Sort projects by the authoritative activity time returned by the API. */
export function sortProjectsByActivity(projects: readonly Project[]): Project[] {
  return projects
    .map((project, index) => ({
      project,
      index,
      activityTime: parseTime(project.lastActivityAt ?? project.createdAt),
      createdTime: parseTime(project.createdAt),
    }))
    .sort((a, b) => {
      const activityDelta = b.activityTime - a.activityTime
      if (activityDelta !== 0) return activityDelta

      // Use creation time as a deterministic tie-breaker, then preserve API order.
      const createdDelta = b.createdTime - a.createdTime
      return createdDelta !== 0 ? createdDelta : a.index - b.index
    })
    .map(({ project }) => project)
}
