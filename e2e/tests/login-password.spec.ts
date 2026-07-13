import { test, expect } from '../fixtures'

test.describe('手机号密码登录', () => {
  test('800×600 与 125% 缩放等效视口均展示手机号+密码表单并保留游客入口', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 })
    await page.goto('/login', { waitUntil: 'domcontentloaded' })

    // 单步：手机号 + 密码
    await expect(page.getByTestId('password-login-form')).toBeVisible()
    await page.getByRole('textbox', { name: '手机号', exact: true }).fill('13800138000')
    await page.getByLabel('密码').fill('secret123')
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()

    // 游客登录（复用离线模式）入口
    const guestButton = page.getByTestId('guest-login-button')
    await expect(guestButton).toBeVisible()

    const box = await guestButton.boundingBox()
    expect(box).not.toBeNull()
    expect((box?.y || 0) + (box?.height || 0)).toBeLessThanOrEqual(600)

    // 800×600 在 125% 系统缩放下约等于 640×480 CSS 像素。
    await page.setViewportSize({ width: 640, height: 480 })
    await guestButton.scrollIntoViewIfNeeded()
    const scaledBox = await guestButton.boundingBox()
    expect(scaledBox).not.toBeNull()
    expect((scaledBox?.y || 0) + (scaledBox?.height || 0)).toBeLessThanOrEqual(480)

    // 游客登录 → 进入「今日经营」（离线模式）
    await guestButton.click()
    await expect(page).toHaveURL(/\/today$/)
    await expect(page.getByTestId('nav-today')).toBeVisible()
  })
})
