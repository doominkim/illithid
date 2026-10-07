import type { Page } from 'playwright-core'

/** Save and sync toasts stack over the controls on a small screen (Windows CI): close them before clicking underneath */
export async function clearToasts(page: Page): Promise<void> {
  const close = page.locator('.mantine-Notification-root button')
  for (let i = 0; i < 10 && (await close.count()) > 0; i++)
    await close
      .first()
      .click({ timeout: 2000 })
      .catch(() => {})
  await page
    .waitForFunction(() => !document.querySelector('.mantine-Notification-root'), null, {
      timeout: 5000
    })
    .catch(() => {})
}
