const ESC = '\u001b'
const BEL = '\u0007'
const ST = '\u009c'

function isFinalByte(char: string) {
  const code = char.charCodeAt(0)
  return code >= 0x40 && code <= 0x7e
}

function consumeControlString(text: string, startIndex: number) {
  let index = startIndex
  while (index < text.length) {
    if (text[index] === BEL) return index + 1
    if (text[index] === ST) return index + 1
    if (text[index] === ESC && text[index + 1] === '\\') return index + 2
    index += 1
  }
  return index
}

function consumeCsi(text: string, startIndex: number) {
  let index = startIndex
  while (index < text.length && !isFinalByte(text[index])) index += 1
  return index < text.length ? index + 1 : index
}

/** Remove terminal control sequences while preserving printable log text. */
export function stripAnsiSequences(text: string) {
  let output = ''

  for (let index = 0; index < text.length;) {
    if (text[index] === '\u009b') {
      index = consumeCsi(text, index + 1)
      continue
    }

    if (text[index] === '\u009d') {
      index = consumeControlString(text, index + 1)
      continue
    }

    if (text[index] !== ESC) {
      output += text[index]
      index += 1
      continue
    }

    const introducer = text[index + 1]
    if (introducer === '[') {
      index = consumeCsi(text, index + 2)
      continue
    }

    if (introducer === ']' || introducer === 'P' || introducer === 'X' || introducer === '^' || introducer === '_') {
      index = consumeControlString(text, index + 2)
      continue
    }

    index += 1
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code < 0x20 || code > 0x2f) break
      index += 1
    }
    if (index < text.length) index += 1
  }

  return output
}
