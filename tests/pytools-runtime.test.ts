// [XJC] 本地智能 Python 工具桥测试：纯逻辑部分（协议解析/相似度/物料化/能力降级），
// 不依赖真实 python——CI 环境 pytools 未安装时一切能力必须干净地为 false/空。
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import './setup.ts'
import {
  detectPytoolsCapabilities,
  dotSimilarity,
  materializeScript,
  parseLastJsonLine,
  resolvePytoolsRoot,
} from '../src/pytools/runtime.ts'
import { OCR_CLI_PY, EMBED_WORKER_PY } from '../src/pytools/scripts.ts'

describe('pytools: parseLastJsonLine', () => {
  test('取 stdout 最后一行 JSON，容忍诊断噪音', () => {
    const stdout = 'loading model...\nwarning: foo\n{"ok":true,"lines":[{"text":"a","score":0.9}]}\n'
    expect(parseLastJsonLine<{ ok: boolean }>(stdout)?.ok).toBe(true)
  })

  test('多行 JSON 取最后一条；坏 JSON 向上回退', () => {
    const stdout = '{"ok":false}\n{"ok":true}\nnot-json-tail'
    expect(parseLastJsonLine<{ ok: boolean }>(stdout)?.ok).toBe(true)
    expect(parseLastJsonLine('{broken\nplain text')).toBeNull()
    expect(parseLastJsonLine('')).toBeNull()
  })
})

describe('pytools: dotSimilarity', () => {
  test('归一化向量点积', () => {
    expect(dotSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(dotSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(dotSimilarity([0.6, 0.8], [0.6, 0.8])).toBeCloseTo(1)
  })
})

describe('pytools: materializeScript', () => {
  test('写入脚本且内容一致时幂等跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xjc-pytools-'))
    try {
      const path = materializeScript(dir, 'test_cli.py', OCR_CLI_PY)
      expect(readFileSync(path, 'utf-8')).toBe(OCR_CLI_PY)
      // 内容变更→覆盖；内容一致→保留
      writeFileSync(path, 'stale')
      const again = materializeScript(dir, 'test_cli.py', EMBED_WORKER_PY)
      expect(readFileSync(again, 'utf-8')).toBe(EMBED_WORKER_PY)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pytools: 能力探测与降级', () => {
  test('测试环境无 pytools 安装 → root=null 且全能力 false', () => {
    // tests/setup.ts 将 DATA_DIR 指向临时目录，真实机器上的 pytools 不会泄漏进来
    expect(resolvePytoolsRoot()).toBeNull()
    const caps = detectPytoolsCapabilities()
    expect(caps.root).toBeNull()
    expect(caps.ocr).toBe(false)
    expect(caps.embedding).toBe(false)
  })

  test('清单存在但模型文件缺失 → embedding 仍为 false（带 BOM 清单可解析）', () => {
    const { getPaths } = require('../src/config/index.ts') as typeof import('../src/config/index.ts')
    const root = resolve(getPaths().data, 'pytools')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(root, { recursive: true })
    try {
      writeFileSync(resolve(root, 'pytools.json'), '\uFEFF{"schemaVersion":1,"ocr":false,"embedding":true}', 'utf-8')
      const caps = detectPytoolsCapabilities()
      expect(caps.root).toBe(root)
      expect(caps.embedding).toBe(false) // model.onnx 不存在
      expect(caps.ocr).toBe(false) // 清单 ocr:false
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
