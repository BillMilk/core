// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SegmentedEffortSlider } from '../SegmentedEffortSlider'

const options = ['minimal', 'low', 'medium', 'high', 'xhigh'].map(value => ({
  value,
  label: value === 'medium' ? '中' : value,
}))

let root: Root | undefined
let container: HTMLDivElement | undefined

function renderSlider(value: string, onChange = vi.fn()) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(
    <SegmentedEffortSlider
      options={options}
      value={value}
      onChange={onChange}
      label="思考强度"
      efficiencyLabel="更高效"
      intelligenceLabel="更智能"
      followCliLabel="跟随 CLI"
      currentLabel="当前"
    />,
  ))
  return {
    onChange,
    slider: container.querySelector('[role="slider"]') as HTMLElement,
    toggle: container.querySelector('[role="switch"]') as HTMLButtonElement,
  }
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('SegmentedEffortSlider', () => {
  it('exposes the selected effort through slider ARIA', () => {
    const { slider, toggle } = renderSlider('medium')
    const labelId = slider.getAttribute('aria-labelledby')
    expect(labelId).toBeTruthy()
    expect(document.getElementById(labelId!)?.textContent).toBe('思考强度')
    expect(slider.getAttribute('aria-valuemin')).toBe('0')
    expect(slider.getAttribute('aria-valuemax')).toBe('4')
    expect(slider.getAttribute('aria-valuenow')).toBe('2')
    expect(slider.getAttribute('aria-valuetext')).toBe('中, medium')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it.each([
    ['ArrowRight', 'high'],
    ['ArrowUp', 'high'],
    ['ArrowLeft', 'low'],
    ['ArrowDown', 'low'],
    ['Home', 'minimal'],
    ['End', 'xhigh'],
  ])('handles %s keyboard navigation', (key, expected) => {
    const onChange = vi.fn()
    const { slider } = renderSlider('medium', onChange)
    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    expect(onChange).toHaveBeenCalledWith(expected)
  })

  it('uses an independent follow-CLI mode and restores the last explicit value', () => {
    const onChange = vi.fn()
    const { toggle } = renderSlider('high', onChange)
    act(() => toggle.click())
    expect(onChange).toHaveBeenCalledWith('')

    act(() => root!.render(
      <SegmentedEffortSlider
        options={options}
        value=""
        onChange={onChange}
        label="思考强度"
        efficiencyLabel="更高效"
        intelligenceLabel="更智能"
        followCliLabel="跟随 CLI"
        currentLabel="当前"
      />,
    ))
    const followingToggle = container!.querySelector('[role="switch"]') as HTMLButtonElement
    expect(followingToggle.getAttribute('aria-checked')).toBe('true')
    act(() => followingToggle.click())
    expect(onChange).toHaveBeenLastCalledWith('high')
  })

  it('selects the nearest segment on pointer click and drag', () => {
    const onChange = vi.fn()
    const { slider } = renderSlider('minimal', onChange)
    slider.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 400, bottom: 44, width: 400, height: 44, x: 0, y: 0, toJSON: () => ({}),
    })
    act(() => slider.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, clientX: 210, bubbles: true,
    })))
    expect(onChange).toHaveBeenCalledWith('medium')
    act(() => slider.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, clientX: 390, bubbles: true,
    })))
    expect(onChange).toHaveBeenLastCalledWith('xhigh')
  })

  it('defaults to medium when leaving follow mode without history', () => {
    const onChange = vi.fn()
    const { toggle, slider } = renderSlider('', onChange)
    expect(slider.getAttribute('aria-disabled')).toBe('true')
    expect(slider.tabIndex).toBe(-1)
    act(() => toggle.click())
    expect(onChange).toHaveBeenCalledWith('medium')
  })
})
