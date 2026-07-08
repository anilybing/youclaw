import { describe, expect, test } from 'bun:test'
import { applyMarkdownHardBreaks } from '../src/components/chat/user-message-markdown'

describe('applyMarkdownHardBreaks', () => {
  test('turns single newlines into markdown hard breaks, keeps paragraph breaks', () => {
    expect(applyMarkdownHardBreaks('第一行\n第二行\n\n新段落')).toBe(
      '第一行  \n第二行\n\n新段落',
    )
  })

  test('leaves fenced code content untouched', () => {
    const input = '看这段代码：\n```js\nconst a = 1\nconst b = 2\n```\n结论一\n结论二'
    expect(applyMarkdownHardBreaks(input)).toBe(
      '看这段代码：  \n```js\nconst a = 1\nconst b = 2\n```\n结论一  \n结论二',
    )
  })

  test('keeps everything after an unclosed fence untouched (streaming paste)', () => {
    const input = '```python\nfor i in range(3):\n    print(i)'
    expect(applyMarkdownHardBreaks(input)).toBe(input)
  })

  test('supports tilde fences with longer closing markers', () => {
    const input = '~~~\nline1\nline2\n~~~~\ntail line\nlast'
    expect(applyMarkdownHardBreaks(input)).toBe(
      '~~~\nline1\nline2\n~~~~\ntail line  \nlast',
    )
  })

  test('does not double up existing hard breaks', () => {
    expect(applyMarkdownHardBreaks('a  \nb\\\nc')).toBe('a  \nb\\\nc')
  })
})
