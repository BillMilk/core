// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceBackgroundServiceDto } from '@agent-tower/shared'
import { SubmitChangesDialog } from '../SubmitChangesDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (source: string, values?: Record<string, unknown>) => (
      values?.count === undefined ? source : source.replace('{count}', String(values.count))
    ),
  }),
}))

function activeService(name: string): WorkspaceBackgroundServiceDto {
  return {
    id: `service-${name}`,
    workspaceId: 'workspace-1',
    name,
    command: 'pnpm',
    args: ['dev'],
    relativeCwd: '.',
    desiredState: 'RUNNING',
    runtimeState: 'RUNNING',
    runtimeInstanceId: `runtime-${name}`,
    pid: 123,
    exitCode: null,
    lastError: null,
    startedAt: '2026-08-07T00:00:00.000Z',
    stoppedAt: null,
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
  }
}

describe('SubmitChangesDialog background services', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('requires an explicit stop-and-submit action when services are active', async () => {
    const onConfirm = vi.fn()
    await act(async () => {
      root.render(
        <SubmitChangesDialog
          isOpen
          onClose={() => undefined}
          branchName="feature/task"
          targetBranch="main"
          commitMessage="fix: merge safely"
          isPending={false}
          activeServices={[activeService('web'), activeService('api')]}
          isCheckingServices={false}
          serviceCheckFailed={false}
          onConfirm={onConfirm}
        />,
      )
    })

    expect(document.body.textContent).toContain('合并前将停止 2 个后台服务')
    expect(document.body.textContent).toContain('web, api')
    expect(document.body.textContent).toContain('停止后不会自动恢复。')
    const submitButton = Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('停止服务并提交'))
    expect(submitButton).toBeDefined()

    await act(async () => submitButton?.click())
    expect(onConfirm).toHaveBeenCalledWith('fix: merge safely', true)
  })

  it('keeps submission disabled while service state is loading', async () => {
    await act(async () => {
      root.render(
        <SubmitChangesDialog
          isOpen
          onClose={() => undefined}
          branchName="feature/task"
          targetBranch="main"
          isPending={false}
          activeServices={[]}
          isCheckingServices
          serviceCheckFailed={false}
          onConfirm={() => undefined}
        />,
      )
    })

    const checkingButton = Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('正在检查后台服务...'))
    expect(checkingButton).toBeDefined()
    expect(checkingButton?.hasAttribute('disabled')).toBe(true)
  })
})
