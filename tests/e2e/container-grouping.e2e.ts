/**
 * E2E Tests: Group by Multi-Account Container
 *
 * The container-sorting setting is only functional on Firefox
 * (where tabs have a cookieStoreId). On Chrome the toggle must be
 * disabled and a "Firefox only" badge must be visible.
 *
 * Actual tab-reordering behaviour cannot be E2E tested here because
 * the Playwright suite runs against Chrome, which has no cookieStoreId.
 */

import { type BrowserContext, expect, type Page, test } from "@playwright/test"
import { getExtensionId, launchExtensionContext, openPopup } from "./helpers/extension-helpers"

let context: BrowserContext
let extensionId: string

test.beforeAll(async () => {
  context = await launchExtensionContext()
  extensionId = await getExtensionId(context)
})

test.afterAll(async () => {
  await context.close()
})

test.describe("Container grouping setting (Chrome)", () => {
  let popup: Page

  test.beforeEach(async () => {
    popup = await openPopup(context, extensionId)
  })

  test.afterEach(async () => {
    if (!popup.isClosed()) await popup.close()
  })

  test("toggle is disabled on Chrome", async () => {
    const toggle = popup.locator("#groupByContainerToggle")
    await expect(toggle).toBeAttached()
    await expect(toggle).toBeDisabled()
  })

  test("Firefox-only badge is visible on Chrome", async () => {
    const badge = popup.locator("#groupByContainerBadge")
    await expect(badge).toBeVisible()
    await expect(badge).toContainText("Firefox only")
  })

  test("container row has disabled styling on Chrome", async () => {
    const container = popup.locator("#groupByContainerContainer")
    await expect(container).toHaveClass(/disabled/)
  })

  test("setting defaults to off", async () => {
    const toggle = popup.locator("#groupByContainerToggle")
    await expect(toggle).not.toBeChecked()
  })
})
