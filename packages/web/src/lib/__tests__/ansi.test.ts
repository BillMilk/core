import { describe, expect, it } from 'vitest'
import { stripAnsiSequences } from '../ansi'

describe('stripAnsiSequences', () => {
  it('preserves ordinary text after C1 OSC terminated by C1 ST', () => {
    expect(stripAnsiSequences('\u009d0;hidden title\u009cready\n')).toBe('ready\n')
  })

  it('strips CSI and ESC-form control strings terminated by BEL or ST', () => {
    expect(stripAnsiSequences(
      '\u001b]0;title\u0007'
      + '\u001b]8;;https://example.com\u001b\\'
      + '\u001b[1;32mready\u001b[0m\n',
    )).toBe('ready\n')
  })

  it('consumes a long unterminated control string without leaking its contents', () => {
    expect(stripAnsiSequences(`before\u009d${'x'.repeat(100_000)}`)).toBe('before')
  })
})
