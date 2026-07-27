// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentType, RuntimeType } from '@agent-tower/shared'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { ProviderSelector } from '../ProviderSelector'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (source: string) => source }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function provider(id: string, runtimeType: RuntimeType): ProviderWithAvailability {
  return {
    provider: {
      id,
      name: id,
      agentType: AgentType.CODEX,
      runtimeType,
      env: {},
      config: {},
      isDefault: false,
    },
    availability: { type: 'INSTALLATION_FOUND' },
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('ProviderSelector', () => {
  it('only offers Providers matching the active Session runtime', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(
      <ProviderSelector
        providers={[
          provider('codex-cli', RuntimeType.CLI),
          provider('codex-acp-primary', RuntimeType.ACP),
          provider('codex-acp-secondary', RuntimeType.ACP),
        ]}
        currentProviderId="codex-acp-primary"
        agentType={AgentType.CODEX}
        runtimeType={RuntimeType.ACP}
        onSelect={vi.fn()}
      />,
    ))

    const trigger = document.querySelector('button')
    act(() => trigger?.click())

    expect(document.body.textContent).toContain('codex-acp-primary')
    expect(document.body.textContent).toContain('codex-acp-secondary')
    expect(document.body.textContent).not.toContain('codex-cli')
    act(() => root.unmount())
  })
})
