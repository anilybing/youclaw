#!/usr/bin/env node
// [XJC] Rebuild customer-guide screenshots from a self-owned disposable app instance.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const webRoot = resolve(repoRoot, 'web')
const outputDir = resolve(webRoot, 'public', 'user-guide', 'assets', 'ui')
const bunCommand = (() => {
  if (process.platform !== 'win32') return 'bun'
  const candidates = [
    process.env.BUN_INSTALL ? resolve(process.env.BUN_INSTALL, 'bin', 'bun.exe') : '',
    process.env.APPDATA ? resolve(process.env.APPDATA, 'npm', 'node_modules', 'bun', 'bin', 'bun.exe') : '',
    process.env.USERPROFILE ? resolve(process.env.USERPROFILE, '.bun', 'bin', 'bun.exe') : '',
  ].filter(Boolean)
  const executable = candidates.find((candidate) => existsSync(candidate))
  if (!executable) throw new Error('Could not locate bun.exe for isolated guide capture')
  return executable
})()
const shots = [
  { name: '01-login.png', path: '/login', expected: '获取验证码' },
  { name: '02-today.png', path: '/today', expected: '今天最重要的三件事' },
  { name: '03-models.png', path: '/today', settingsTab: 'models', expected: '当前模型' },
  { name: '04-workbench.png', path: '/workbench', expected: '自动流水线' },
  { name: '05-chat.png', path: '/chat', expected: '有什么可以帮你的？' },
  { name: '06-agents.png', path: '/agents', expected: '选择一个 Agent 查看详情' },
  { name: '07-knowledge.png', path: '/knowledge', expected: '上传文档' },
  { name: '08-workflows.png', path: '/workflows', expected: '看得见的多步自动化' },
  { name: '09-tasks-create.png', path: '/cron', clickTestId: 'task-create-btn', expected: '创建定时任务' },
  { name: '10-channels.png', path: '/today', settingsTab: 'channels', expected: '暂无渠道' },
  { name: '11-media.png', path: '/today', settingsTab: 'voice', expected: '服务商快速配置' },
  { name: '12-skills.png', path: '/skills', expected: '技能市场' },
  { name: '13-memory.png', path: '/memory', expected: '全局 MEMORY.md' },
  { name: '14-fulfillment.png', path: '/fulfillment', expected: '演示会员兑换码' },
  { name: '15-logs.png', path: '/logs', expected: '日志' },
  { name: '16-activation.png', path: '/activation', expected: '激活码兑换' },
]

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

async function waitForUrl(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`)
}

function startProcess(args, cwd, env) {
  const child = spawn(bunCommand, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  const remember = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-12_000)
  }
  child.stdout.on('data', remember)
  child.stderr.on('data', remember)
  child.on('error', (error) => remember(String(error)))
  child.getRecentOutput = () => output
  return child
}

function stopProcessTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    child.kill('SIGTERM')
  }
}

async function requestJson(baseUrl, path, init) {
  const response = await fetch(`${baseUrl}${path}`, init)
  if (!response.ok) {
    throw new Error(`Guide demo setup failed: ${init?.method || 'GET'} ${path} -> ${response.status}`)
  }
  return response.json()
}

async function validateScreenshots(directory) {
  for (const shot of shots) {
    const path = resolve(directory, shot.name)
    const info = await stat(path)
    if (!info.isFile() || info.size < 10_000) throw new Error(`Invalid screenshot file: ${shot.name}`)
    const bytes = await readFile(path)
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error(`Screenshot is not PNG: ${shot.name}`)
    }
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    if (width < 1200 || height < 800) {
      throw new Error(`Screenshot resolution is too small: ${shot.name} (${width}x${height})`)
    }
  }
}

async function replaceOutputAtomically(stagingDir) {
  const backupDir = `${outputDir}.backup-${process.pid}`
  await rm(backupDir, { recursive: true, force: true })
  let movedExisting = false
  try {
    try {
      await rename(outputDir, backupDir)
      movedExisting = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await rename(stagingDir, outputDir)
    if (movedExisting) await rm(backupDir, { recursive: true, force: true })
  } catch (error) {
    if (movedExisting) {
      await rm(outputDir, { recursive: true, force: true })
      await rename(backupDir, outputDir)
    }
    throw error
  }
}

const dataDir = await mkdtemp(resolve(tmpdir(), 'xjc-illustrated-guide-'))
await mkdir(dirname(outputDir), { recursive: true })
const stagingDir = await mkdtemp(resolve(dirname(outputDir), '.ui-capture-'))
const backendPort = await freePort()
const frontendPort = await freePort()
const backendUrl = `http://127.0.0.1:${backendPort}`
const frontendUrl = `http://127.0.0.1:${frontendPort}`
let backend
let frontend
let browser
let replaced = false

try {
  backend = startProcess(['run', 'src/index.ts'], repoRoot, {
    PORT: String(backendPort),
    DATA_DIR: dataDir,
  })
  await waitForUrl(`${backendUrl}/api/env-check`)
  frontend = startProcess(
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'],
    webRoot,
    { PORT: String(backendPort) },
  )
  await waitForUrl(`${frontendUrl}/login`)

  await requestJson(frontendUrl, '/api/business/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      businessName: '青禾内容工作室',
      businessType: '一人内容服务工作室',
      offer: '为本地品牌提供短视频脚本、公众号内容与月度运营方案',
      targetCustomer: '预算有限、需要稳定内容输出的中小企业主',
      channels: ['微信', '小红书', '抖音'],
      currentGoals: ['本周交付 3 份客户方案', '建立每周内容排期', '减少重复资料整理'],
      constraints: '所有对外发布先人工确认；月度模型预算不超过 300 元',
      timeZone: 'Asia/Shanghai',
    }),
  })
  await requestJson(frontendUrl, '/api/fulfillment/skus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'demo-membership',
      title: '演示会员兑换码',
      deliveryTemplate: '感谢购买，您的兑换码是：{{secret}}。请在 24 小时内完成兑换。',
    }),
  })
  await requestJson(frontendUrl, '/api/fulfillment/skus/demo-membership/cards', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'DEMO-CODE-001\nDEMO-CODE-002\nDEMO-CODE-003' }),
  })

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
  })
  for (const shot of shots) {
    await page.goto(`${frontendUrl}${shot.path}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    await page.waitForFunction(
      () => !document.body.innerText.includes('正在启动'),
      undefined,
      { timeout: 30_000 },
    )
    if (shot.settingsTab) {
      await page.evaluate((tab) => {
        window.dispatchEvent(new CustomEvent('xjc:open-settings', { detail: { tab } }))
      }, shot.settingsTab)
      await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 10_000 })
    }
    if (shot.clickTestId) await page.getByTestId(shot.clickTestId).click()
    await page.getByText(shot.expected, { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 })
    await page.screenshot({
      path: resolve(stagingDir, shot.name),
      animations: 'disabled',
      caret: 'hide',
    })
    console.log(`[guide] captured ${shot.name}`)
  }
  await validateScreenshots(stagingDir)
  await replaceOutputAtomically(stagingDir)
  replaced = true
  console.log(`[guide] ${shots.length} verified screenshots replaced atomically in ${outputDir}`)
} catch (error) {
  const backendLog = backend?.getRecentOutput?.() || ''
  const frontendLog = frontend?.getRecentOutput?.() || ''
  if (backendLog) console.error(`[guide backend]\n${backendLog}`)
  if (frontendLog) console.error(`[guide frontend]\n${frontendLog}`)
  throw error
} finally {
  if (browser) await browser.close().catch(() => {})
  stopProcessTree(frontend)
  stopProcessTree(backend)
  await rm(dataDir, { recursive: true, force: true })
  if (!replaced) await rm(stagingDir, { recursive: true, force: true })
}
