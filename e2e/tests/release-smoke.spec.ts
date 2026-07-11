import { expect, test } from '@playwright/test'

test('release shell and local API start without external services', async ({ page, request }) => {
  const health = await request.get('/api/health')
  expect(health.ok()).toBe(true)
  await expect(health.json()).resolves.toMatchObject({ status: 'ok' })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveTitle(/XiaoJuClaw/)
  await expect(page).toHaveURL(/\/today$/)
  await expect(page.getByTestId('today-operations-page')).toBeVisible()
  await expect(page.getByTestId('nav-chat')).toBeVisible()

  await page.getByTestId('nav-agents').click()
  await expect(page).toHaveURL(/\/agents$/)

  await page.getByTestId('nav-guide').click()
  await expect(page).toHaveURL(/\/guide$/)
  const guide = page.frameLocator('iframe[title="XiaoJuClaw 图文操作手册"]')
  await expect(guide.getByRole('heading', { name: '跟着图片操作，完成你的第一个数字员工任务' })).toBeVisible()
  await expect(guide.locator('.ui-figure img')).toHaveCount(16)
  await guide.locator('#searchInput').fill('工作流')
  await expect(guide.locator('.guide-section:visible')).not.toHaveCount(17)

  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '使用手册' }).click()
  await expect(page).toHaveURL(/\/guide$/)
})
