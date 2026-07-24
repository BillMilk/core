// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getPublicProviderTestEndpoint,
  ProviderDraftTestResultPanel,
} from '../ProviderDraftTestResultPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ locale: 'en', t: (source: string) => source }),
}))

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('ProviderDraftTestResultPanel', () => {
  it('shows the redacted target and localized time without query credentials', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(
      <ProviderDraftTestResultPanel result={{
        ok: true,
        stage: 'connection',
        summary: 'Connection verified',
        target: {
          kind: 'api',
          source: 'codex-openai',
          endpoint: 'https://user:password@proxy.example/very/long/models?api_key=query-secret#fragment',
        },
        testedAt: '2026-07-15T10:20:30.000Z',
      }} />,
    ))

    expect(container.textContent).toContain('https://proxy.example/very/long/models')
    expect(container.textContent).not.toContain('user')
    expect(container.textContent).not.toContain('password')
    expect(container.textContent).not.toContain('api_key')
    expect(container.textContent).not.toContain('query-secret')
    expect(container.textContent).not.toContain('2026-07-15T10:20:30.000Z')
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe('2026-07-15T10:20:30.000Z')
    expect(container.querySelector('code')?.className).toContain('break-all')
    expect(container.querySelector('[data-provider-test-result] .min-w-0')).not.toBeNull()
  })

  it('replaces the visible target when consecutive valid endpoints are tested', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const renderResult = (endpoint: string) => act(() => root!.render(
      <ProviderDraftTestResultPanel result={{
        ok: true,
        stage: 'connection',
        summary: 'Connection verified',
        target: { kind: 'api', source: 'codex-openai', endpoint },
        testedAt: '2026-07-15T10:20:30.000Z',
      }} />,
    ))

    renderResult('https://endpoint-a.example/v1/models')
    expect(container.textContent).toContain('https://endpoint-a.example/v1/models')

    renderResult('https://endpoint-b.example/v1/models')
    expect(container.textContent).toContain('https://endpoint-b.example/v1/models')
    expect(container.textContent).not.toContain('https://endpoint-a.example/v1/models')
  })

  it('refuses to display non-HTTP or invalid endpoint strings', () => {
    expect(getPublicProviderTestEndpoint('file:///tmp/secret')).toBeNull()
    expect(getPublicProviderTestEndpoint('not a URL?api_key=secret')).toBeNull()
    expect(getPublicProviderTestEndpoint('https://proxy.example/v1?token=secret'))
      .toBe('https://proxy.example/v1')
  })
})
