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
})
