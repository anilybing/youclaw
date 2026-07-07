import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Jimp } from 'jimp'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ecom-image golden 测试：动态生成样例图 -> 子进程跑真实 CLI -> jimp 回读断言尺寸/像素/产物数
// 契约：成功 stdout 单行 JSON {ok,mode,count,outdir,outputs} 退出码 0；失败 stderr + 退出码 1

const CLI = path.resolve(import.meta.dir, '../src/ecom-image/cli.ts')

const WHITE = 0xffffffff
const RED = 0xff0000ff

let tmpDir: string
let rawDir: string
let redPng: string // 100x60 红
let bluePng: string // 60x100 蓝
let wmPng: string // 40x40 水印

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
  json: Record<string, unknown> | null
}

function runCli(args: string[]): CliResult {
  // 用 process.execPath 直连 bun 二进制，绕开 Windows 上 npm 的 bun.ps1/.cmd shim
  // （shim 更慢且密集 spawn 偶发 EPERM）；与 office-pdf.test.ts 一致。
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = proc.stdout.toString('utf8').trim()
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(stdout)
  } catch {
    json = null
  }
  return { exitCode: proc.exitCode, stdout, stderr: proc.stderr.toString('utf8'), json }
}

async function dims(file: string): Promise<{ w: number; h: number }> {
  const img = await Jimp.read(file)
  return { w: img.width, h: img.height }
}

// jimp 是重依赖（打包产物 1MB+）；在新 bun 子进程里首次加载/转译可能逼近甚至
// 超过 bun 默认 5s 单测超时，使首个 spawn 型用例 flaky 超时。放宽默认超时，
// 并在 beforeAll 预热一次子进程，让冷启动只付一次且发生在用例计时器之外。
setDefaultTimeout(30_000)

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ecom-image-test-'))
  rawDir = path.join(tmpDir, 'raw')
  mkdirSync(rawDir, { recursive: true })
  redPng = path.join(rawDir, 'red.png')
  bluePng = path.join(rawDir, 'blue.png')
  wmPng = path.join(tmpDir, 'wm.png')
  await new Jimp({ width: 100, height: 60, color: RED }).write(redPng as `${string}.png`)
  await new Jimp({ width: 60, height: 100, color: 0x0000ffff }).write(bluePng as `${string}.png`)
  await new Jimp({ width: 40, height: 40, color: 0x00ff00ff }).write(wmPng as `${string}.png`)
  // 预热子进程：吃掉 jimp 冷启动，避免被算进后续用例的超时
  runCli(['--mode', 'fit', '--input', redPng, '--outdir', path.join(tmpDir, '__warmup'), '--width', '8', '--height', '8'])
}, 60_000)

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('ecom-image CLI', () => {
  test('fit contain：输出精确方图且四周白底', async () => {
    const outdir = path.join(tmpDir, 'fit-contain')
    const res = runCli(['--mode', 'fit', '--input', redPng, '--outdir', outdir, '--width', '200', '--height', '200'])
    expect(res.stderr).toBe('')
    expect(res.exitCode).toBe(0)
    expect(res.json).toMatchObject({ ok: true, mode: 'fit', count: 1 })

    const out = path.join(outdir, 'red.png')
    expect(await dims(out)).toEqual({ w: 200, h: 200 })
    const img = await Jimp.read(out)
    expect(img.getPixelColor(0, 0)).toBe(WHITE) // 顶部留白=白底
    expect(img.getPixelColor(100, 100)).toBe(RED) // 中心=原图
  })

  test('fit cover：竖图裁剪填满为精确方图', async () => {
    const outdir = path.join(tmpDir, 'fit-cover')
    const res = runCli(['--mode', 'fit', '--input', bluePng, '--outdir', outdir, '--width', '200', '--height', '200', '--fit', 'cover'])
    expect(res.exitCode).toBe(0)
    expect(await dims(path.join(outdir, 'blue.png'))).toEqual({ w: 200, h: 200 })
  })

  test('compress --max：最长边被限制且等比', async () => {
    const outdir = path.join(tmpDir, 'compress')
    const res = runCli(['--mode', 'compress', '--input', redPng, '--outdir', outdir, '--max', '50'])
    expect(res.exitCode).toBe(0)
    expect(res.json).toMatchObject({ ok: true, mode: 'compress', count: 1 })
    expect(await dims(path.join(outdir, 'red.png'))).toEqual({ w: 50, h: 30 }) // 100x60 → 50x30
  })

  test('convert：png → jpg 改扩展名', async () => {
    const outdir = path.join(tmpDir, 'convert')
    const res = runCli(['--mode', 'convert', '--input', redPng, '--outdir', outdir, '--format', 'jpg'])
    expect(res.exitCode).toBe(0)
    expect(res.json).toMatchObject({ ok: true, outputs: ['red.jpg'] })
    expect(readdirSync(outdir)).toEqual(['red.jpg'])
  })

  test('convert 透明 png → jpg：透明区铺白底而非编码成黑块', async () => {
    const transPng = path.join(tmpDir, 'trans.png')
    await new Jimp({ width: 30, height: 30, color: 0x00000000 }).write(transPng as `${string}.png`) // 全透明
    const outdir = path.join(tmpDir, 'trans-jpg')
    const res = runCli(['--mode', 'convert', '--input', transPng, '--outdir', outdir, '--format', 'jpg'])
    expect(res.exitCode).toBe(0)
    const px = (await Jimp.read(path.join(outdir, 'trans.jpg'))).getPixelColor(15, 15) >>> 0
    const [r, g, b] = [(px >>> 24) & 0xff, (px >>> 16) & 0xff, (px >>> 8) & 0xff]
    expect(Math.min(r, g, b)).toBeGreaterThan(240) // 近白（jpeg 有压缩噪声），而非 0x00 黑
  })

  test('watermark：叠加水印后主图尺寸不变', async () => {
    const outdir = path.join(tmpDir, 'wm')
    const res = runCli(['--mode', 'watermark', '--input', redPng, '--outdir', outdir, '--wm', wmPng, '--pos', 'bottom-right', '--scale', '0.3'])
    expect(res.stderr).toBe('')
    expect(res.exitCode).toBe(0)
    expect(res.json).toMatchObject({ ok: true, mode: 'watermark', count: 1 })
    expect(await dims(path.join(outdir, 'red.png'))).toEqual({ w: 100, h: 60 })
  })

  test('watermark --pos center：正中定位可用（回归：center 无连字符）', async () => {
    const outdir = path.join(tmpDir, 'wm-center')
    const res = runCli(['--mode', 'watermark', '--input', redPng, '--outdir', outdir, '--wm', wmPng, '--pos', 'center', '--scale', '0.3'])
    expect(res.stderr).toBe('')
    expect(res.exitCode).toBe(0)
    expect(res.json).toMatchObject({ ok: true, mode: 'watermark', count: 1 })
    // 水印落在中心区域（左上角仍是原图红色，未被 NaN 定位破坏）
    const img = await Jimp.read(path.join(outdir, 'red.png'))
    expect(img.getPixelColor(0, 0)).toBe(RED)
  })

  test('fit 尺寸为负/零：报可读错误', () => {
    const res = runCli(['--mode', 'fit', '--input', redPng, '--outdir', path.join(tmpDir, 'neg'), '--width', '-5', '--height', '200'])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('正整数')
  })

  test('目录批量：处理第一层全部图片', async () => {
    const outdir = path.join(tmpDir, 'batch')
    const res = runCli(['--mode', 'fit', '--input', rawDir, '--outdir', outdir, '--width', '300', '--height', '300'])
    expect(res.exitCode).toBe(0)
    expect(res.json).toMatchObject({ ok: true, count: 2 })
    expect(readdirSync(outdir).sort()).toEqual(['blue.png', 'red.png'])
  })

  test('输出已存在：默认报错，--overwrite 才覆盖', () => {
    const outdir = path.join(tmpDir, 'ow')
    const first = runCli(['--mode', 'convert', '--input', redPng, '--outdir', outdir, '--format', 'png'])
    expect(first.exitCode).toBe(0)
    const second = runCli(['--mode', 'convert', '--input', redPng, '--outdir', outdir, '--format', 'png'])
    expect(second.exitCode).toBe(1)
    expect(second.stderr).toContain('--overwrite')
    const third = runCli(['--mode', 'convert', '--input', redPng, '--outdir', outdir, '--format', 'png', '--overwrite'])
    expect(third.exitCode).toBe(0)
  })

  test('参数缺失 / mode 无效：退出码 1', () => {
    const missing = runCli(['--mode', 'fit', '--input', redPng])
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('--outdir')
    const badMode = runCli(['--mode', 'blur', '--input', redPng, '--outdir', path.join(tmpDir, 'x')])
    expect(badMode.exitCode).toBe(1)
    expect(badMode.stderr).toContain('fit|compress|watermark|convert')
  })

  test('fit 缺尺寸：报可读错误', () => {
    const res = runCli(['--mode', 'fit', '--input', redPng, '--outdir', path.join(tmpDir, 'y')])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('--width')
  })
})
