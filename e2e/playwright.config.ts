import { defineConfig } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RELEASE_SMOKE = process.env.XJC_E2E_RELEASE_SMOKE === '1'
const E2E_BACKEND_PORT = RELEASE_SMOKE ? 62701 : 62601
const E2E_WEB_PORT = RELEASE_SMOKE ? 5181 : 5173
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB_ROOT = resolve(REPO_ROOT, 'web')
const DATA_DIR = process.env.XJC_E2E_DATA_DIR || resolve(REPO_ROOT, 'data', 'e2e')
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
)

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: RELEASE_SMOKE ? 0 : 1,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${E2E_WEB_PORT}`,
    locale: 'zh-CN',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-e2e',
      testIgnore: /release-smoke\.spec\.ts/,
      use: { browserName: 'chromium' },
    },
    {
      name: 'release-smoke',
      testMatch: /release-smoke\.spec\.ts/,
      use: { browserName: 'chromium' },
    },
  ],
  webServer: [
    {
      command: 'bun run dev',
      port: E2E_BACKEND_PORT,
      reuseExistingServer: !RELEASE_SMOKE && !process.env.CI,
      cwd: REPO_ROOT,
      env: {
        ...inheritedEnv,
        PORT: String(E2E_BACKEND_PORT),
        DATA_DIR,
        WORKSPACE_DIR: resolve(DATA_DIR, 'workspace'),
        LOG_LEVEL: 'error',
        XiaoJuClaw_API_URL: '',
        XiaoJuClaw_WEBSITE_URL: '',
        YOUCLAW_API_URL: '',
        YOUCLAW_WEBSITE_URL: '',
      },
    },
    {
      command: `bun run dev -- --host 127.0.0.1 --port ${E2E_WEB_PORT} --strictPort`,
      port: E2E_WEB_PORT,
      reuseExistingServer: !RELEASE_SMOKE && !process.env.CI,
      cwd: WEB_ROOT,
      env: {
        ...inheritedEnv,
        PORT: String(E2E_BACKEND_PORT),
        BACKEND_HOST: '127.0.0.1',
      },
    },
  ],
})
