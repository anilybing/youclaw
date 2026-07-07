/**
 * T-D6：file-organizer golden 测试
 *
 * 覆盖：dry-run 默认不动文件、apply 移动正确且文件总数守恒、
 * 重名冲突加序号不覆盖、危险目录拒绝、bydate 分组。
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = join(import.meta.dir, '../../skills/file-organizer/scripts/organize.mjs')

let workDir = ''

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bun', SCRIPT, ...args])
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  }
}

function countFilesRecursive(dir: string): number {
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFilesRecursive(join(dir, entry.name))
    else count += 1
  }
  return count
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'xjc-organizer-'))
  const files = ['报告.docx', '数据.xlsx', '照片.png', '演示.pptx', '压缩.zip', '影片.mp4', '说明.txt', '脚本.ps1', '未知.xyz', '手册.pdf']
  for (const name of files) writeFileSync(join(workDir, name), `content of ${name}`)
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('file-organizer', () => {
  test('构建产物存在（先 bun run build:file-organizer）', () => {
    expect(existsSync(SCRIPT)).toBe(true)
  })

  test('默认 dry-run：输出计划但不移动任何文件', () => {
    const res = run(['--dir', workDir, '--rule', 'bytype'])
    expect(res.code).toBe(0)
    const out = JSON.parse(res.stdout)
    expect(out.dryRun).toBe(true)
    expect(out.count).toBe(10)
    // 文件仍在原位，未创建分类目录
    expect(readdirSync(workDir).length).toBe(10)
    expect(existsSync(join(workDir, '文档'))).toBe(false)
  })

  test('apply：按类型移动、报告生成、文件总数守恒', () => {
    const before = countFilesRecursive(workDir)
    const res = run(['--dir', workDir, '--rule', 'bytype', '--apply'])
    expect(res.code).toBe(0)
    const out = JSON.parse(res.stdout)
    expect(out.dryRun).toBe(false)
    expect(out.moved).toBe(10)

    expect(existsSync(join(workDir, '文档', '报告.docx'))).toBe(true)
    expect(existsSync(join(workDir, '表格', '数据.xlsx'))).toBe(true)
    expect(existsSync(join(workDir, '其他', '未知.xyz'))).toBe(true)
    // 报告 + 原文件全部还在（守恒 = 原 10 个 + 新增报告 1 个）
    expect(existsSync(out.report)).toBe(true)
    expect(countFilesRecursive(workDir)).toBe(before + 1)
    expect(readFileSync(out.report, 'utf8')).toContain('未删除任何文件')
  })

  test('重名冲突：目标已有同名文件时加序号，不覆盖', () => {
    mkdirSync(join(workDir, '文档'), { recursive: true })
    writeFileSync(join(workDir, '文档', '报告.docx'), 'EXISTING')
    const res = run(['--dir', workDir, '--rule', 'bytype', '--apply'])
    expect(res.code).toBe(0)
    // 旧文件内容未被覆盖
    expect(readFileSync(join(workDir, '文档', '报告.docx'), 'utf8')).toBe('EXISTING')
    expect(existsSync(join(workDir, '文档', '报告 (1).docx'))).toBe(true)
  })

  test('bydate：按修改月份分组', () => {
    const res = run(['--dir', workDir, '--rule', 'bydate', '--apply'])
    expect(res.code).toBe(0)
    const now = new Date()
    const bucket = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    expect(existsSync(join(workDir, bucket, '报告.docx'))).toBe(true)
  })

  test('危险目录拒绝：盘根 / 非法 rule / 不存在目录', () => {
    expect(run(['--dir', 'C:\\', '--rule', 'bytype']).code).toBe(1)
    expect(run(['--dir', workDir, '--rule', 'wild']).code).toBe(1)
    expect(run(['--dir', join(workDir, 'nope'), '--rule', 'bytype']).code).toBe(1)
  })
})
