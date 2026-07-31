// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalTabs } from '../TerminalTabs'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { pasteMock, sendInputMock, terminalUnmountMock, toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  pasteMock: vi.fn(),
  sendInputMock: vi.fn(),
  terminalUnmountMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}))

vi.mock('../StandaloneTerminalView', async () => {
  const ReactModule = await import('react')
  return {
    StandaloneTerminalView: ({ onReady }: {
      onReady?: (api: { paste: (data: string) => void; sendInput: (data: string) => void }) => void
    }) => {
      ReactModule.useEffect(() => {
        onReady?.({ paste: pasteMock, sendInput: sendInputMock })
        return terminalUnmountMock
      }, [])
      return ReactModule.createElement('div', { 'data-testid': 'terminal' })
    },
  }
})

vi.mock('../QuickCommandsPopover', () => ({ QuickCommandsPopover: () => null }))
vi.mock('../WorkspaceBackgroundServices', () => ({
  WorkspaceBackgroundServices: () => <div data-testid="background-services" />,
}))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }))
vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}))

describe('TerminalTabs mobile paste control', () => {
  let container: HTMLDivElement
  let root: Root
  let originalClipboard: PropertyDescriptor | undefined

  beforeEach(async () => {
    pasteMock.mockReset()
    sendInputMock.mockReset()
    terminalUnmountMock.mockReset()
    toastErrorMock.mockReset()
    toastSuccessMock.mockReset()
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root.render(<TerminalTabs />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  function setClipboardReadText(readText: () => Promise<string>) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText },
    })
  }

  function getPasteButton() {
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Paste into terminal"]')
    expect(button).not.toBeNull()
    return button!
  }

  async function clickPasteButton() {
    await act(async () => {
      getPasteButton().click()
      await Promise.resolve()
    })
  }

  it('pastes a single clipboard line directly through the terminal API', async () => {
    const readText = vi.fn(async () => 'echo hello')
    setClipboardReadText(readText)

    await clickPasteButton()

    expect(readText).toHaveBeenCalledOnce()
    expect(pasteMock).toHaveBeenCalledWith('echo hello')
    expect(toastSuccessMock).toHaveBeenCalledWith('Pasted into terminal')
  })

  it('asks for confirmation before pasting multiple lines', async () => {
    setClipboardReadText(vi.fn(async () => 'echo one\necho two'))

    await clickPasteButton()

    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Terminal paste content"]')
    expect(textarea?.value).toBe('echo one\necho two')
    expect(pasteMock).not.toHaveBeenCalled()

    const confirmButton = Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent === 'Paste')
    expect(confirmButton).toBeDefined()
    await act(async () => confirmButton!.click())

    expect(pasteMock).toHaveBeenCalledWith('echo one\necho two')
  })

  it('falls back to a native textarea when clipboard access fails', async () => {
    setClipboardReadText(vi.fn(async () => {
      throw new DOMException('Clipboard access denied', 'NotAllowedError')
    }))

    await clickPasteButton()

    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Terminal paste content"]')
    expect(textarea).not.toBeNull()

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      valueSetter?.call(textarea, 'pwd')
      textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirmButton = Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent === 'Paste')
    await act(async () => confirmButton!.click())

    expect(pasteMock).toHaveBeenCalledWith('pwd')
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('keeps interactive terminals mounted while viewing workspace background services', async () => {
    await act(async () => {
      root.render(<TerminalTabs workspaceId="workspace-1" />)
    })
    terminalUnmountMock.mockClear()

    const servicesButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Background services')
    await act(async () => servicesButton?.click())

    expect(container.querySelector('[data-testid="background-services"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="terminal"]')).not.toBeNull()
    expect(terminalUnmountMock).not.toHaveBeenCalled()
  })
})
