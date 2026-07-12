// [XJC] 本地 OCR 工具测试：路径守卫 + 低置信标注 + 未安装时不挂载。
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import './setup.ts'
import { assertReadableImagePath, createOcrTools, formatOcrLines } from '../src/agent/ocr-mcp.ts'
import { getPaths } from '../src/config/index.ts'

describe('ocr-mcp: assertReadableImagePath', () => {
  test('非图片扩展名拒绝', () => {
    expect(() => assertReadableImagePath('C:/tmp/evil.exe')).toThrow(/仅支持图片/)
    expect(() => assertReadableImagePath('/tmp/doc.pdf')).toThrow(/仅支持图片/)
  })

  test('不存在的文件拒绝', () => {
    expect(() => assertReadableImagePath(resolve(getPaths().workspace, 'no-such-file.png'))).toThrow(/不存在或不可读/)
  })

  test('白名单目录外的真实图片拒绝', () => {
    const outside = resolve(getPaths().data, 'outside.png')
    mkdirSync(getPaths().data, { recursive: true })
    writeFileSync(outside, 'fake-png-bytes')
    expect(() => assertReadableImagePath(outside)).toThrow(/必须位于聊天附件或工作区/)
  })

  test('工作区内图片放行并返回 realpath', () => {
    const dir = resolve(getPaths().workspace)
    mkdirSync(dir, { recursive: true })
    const inside = resolve(dir, 'ok.png')
    writeFileSync(inside, 'fake-png-bytes')
    const real = assertReadableImagePath(inside)
    expect(real.toLowerCase()).toContain('ok.png')
  })
})

describe('ocr-mcp: formatOcrLines', () => {
  test('低置信行加标注，高置信行原样', () => {
    const text = formatOcrLines([
      { text: '增值税专用发票', score: 0.98 },
      { text: '价税合计：壹仟贰佰元整', score: 0.51 },
    ])
    expect(text).toContain('增值税专用发票')
    expect(text).not.toContain('增值税专用发票【低置信')
    expect(text).toContain('价税合计：壹仟贰佰元整【低置信 51%】')
  })
})

describe('ocr-mcp: 能力门控', () => {
  test('未安装 pytools 时不挂载工具', () => {
    expect(createOcrTools()).toEqual([])
  })
})
