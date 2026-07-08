// Streamdown has no remark-breaks: single newlines inside a paragraph
// collapse into spaces, so a user's multi-line input (or pasted, unfenced
// code) renders as one run-on line. Append markdown hard breaks (trailing
// two spaces) to preserve line breaks — but never inside fenced code.

const fenceLinePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/

interface OpenFence {
  char: '`' | '~'
  length: number
}

function asFenceOpen(line: string): OpenFence | null {
  const match = line.match(fenceLinePattern)
  if (!match) return null
  const marker = match[1]
  const char = marker[0] as OpenFence['char']
  // CommonMark: a backtick fence's info string cannot contain backticks
  if (char === '`' && match[2].includes('`')) return null
  return { char, length: marker.length }
}

function closesFence(line: string, fence: OpenFence): boolean {
  const match = line.match(fenceLinePattern)
  if (!match) return false
  const marker = match[1]
  return (
    marker[0] === fence.char &&
    marker.length >= fence.length &&
    match[2].trim() === ''
  )
}

export function applyMarkdownHardBreaks(content: string): string {
  const lines = content.split('\n')
  let fence: OpenFence | null = null

  return lines
    .map((line, index) => {
      if (fence) {
        if (closesFence(line, fence)) fence = null
        return line
      }
      const opened = asFenceOpen(line)
      if (opened) {
        fence = opened
        return line
      }
      if (!line.trim()) return line
      const next = lines[index + 1]
      // Last line of the text or of a paragraph: no break needed
      if (next === undefined || !next.trim()) return line
      // Already an explicit hard break
      if (line.endsWith('\\') || line.endsWith('  ')) return line
      return `${line}  `
    })
    .join('\n')
}
