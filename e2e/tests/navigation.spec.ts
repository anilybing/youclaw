import { test, expect } from '../fixtures'

test.describe('导航冒烟测试', () => {
  test('页面加载成功', async ({ page }) => {
    // 根路径会进入“一人公司”的今日经营首屏。
    await expect(page).toHaveTitle(/.+/)
    await expect(page).toHaveURL(/\/today$/)
    await expect(page.getByTestId('nav-today')).toBeVisible()
    await expect(page.getByTestId('nav-chat')).toBeVisible()
  })

  test('侧边栏导航可用', async ({ page }) => {
    const routes = [
      { testId: 'nav-today', url: '/today' },
      { testId: 'nav-agents', url: '/agents' },
      { testId: 'nav-cron', url: '/cron' },
      { testId: 'nav-memory', url: '/memory' },
      { testId: 'nav-chat', url: '/chat' },
    ]
    for (const { testId, url } of routes) {
      await page.getByTestId(testId).click()
      await expect(page).toHaveURL(new RegExp(`${url}$`))
    }
  })
})
