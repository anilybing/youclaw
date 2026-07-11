import { test, expect } from '../fixtures'

test.describe('生产验证码登录', () => {
  test('800×600 与 125% 缩放等效视口均可操作并保留离线入口', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 })
    await page.route('**/api/auth/otp/request', async (route) => {
      const payload = JSON.parse(route.request().postData() || '{}')
      expect(payload).toEqual({ mobile: '13800138000' })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          otpChallengeId: 'otp_e2e',
          expiresIn: 300,
          identityType: 'mobile',
          maskedIdentity: '138****8000',
        }),
      })
    })

    await page.goto('/login', { waitUntil: 'domcontentloaded' })
    await page.getByRole('textbox', { name: '手机号', exact: true }).fill('13800138000')
    await page.getByRole('button', { name: '获取验证码' }).click()

    const otpInput = page.getByTestId('otp-code-input')
    await expect(otpInput).toBeVisible()
    await expect(page.getByText('138****8000')).toBeVisible()
    await expect(page.getByRole('button', { name: /验证并登录/ })).toBeVisible()
    const offlineButton = page.getByRole('button', { name: /离线使用本地模型/ })
    await expect(offlineButton).toBeVisible()

    const box = await otpInput.boundingBox()
    expect(box).not.toBeNull()
    expect((box?.y || 0) + (box?.height || 0)).toBeLessThanOrEqual(600)

    // 800×600 在 125% 系统缩放下约等于 640×480 CSS 像素。
    await page.setViewportSize({ width: 640, height: 480 })
    await otpInput.scrollIntoViewIfNeeded()
    const scaledBox = await otpInput.boundingBox()
    expect(scaledBox).not.toBeNull()
    expect((scaledBox?.y || 0) + (scaledBox?.height || 0)).toBeLessThanOrEqual(480)

    await offlineButton.scrollIntoViewIfNeeded()
    await offlineButton.click()
    await expect(page).toHaveURL(/\/today$/)
    await expect(page.getByTestId('nav-today')).toBeVisible()
  })
})
