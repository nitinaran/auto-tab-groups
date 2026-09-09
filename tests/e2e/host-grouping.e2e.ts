/**
 * E2E Tests: Group by Host
 *
 * Unlike container grouping (Firefox-only, gated on cookieStoreId), host-based
 * reordering only needs a tab's URL, so it works identically on Chrome and
 * Firefox. This suite verifies both the settings UI and the actual reordering
 * behaviour, which container-grouping's Chrome-only suite cannot do.
 */

import { type BrowserContext, expect, type Page, test } from "@playwright/test"
import {
  addCustomRule,
  createTab,
  enableAutoGroup,
  getExtensionId,
  launchExtensionContext,
  sendMessage,
  setupCleanState,
  TEST_URLS,
  waitForGroup
} from "./helpers/extension-helpers"

let context: BrowserContext
let extensionId: string

/** Tabs in a group, ordered by tab-strip position, reduced to their hostname */
async function getGroupHostsOrdered(popupPage: Page, groupId: number): Promise<string[]> {
  return await popupPage.evaluate(async gid => {
    const tabs = await chrome.tabs.query({ groupId: gid })
    return tabs
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map(t => (t.url ? new URL(t.url).hostname : ""))
  }, groupId)
}

test.beforeAll(async () => {
  context = await launchExtensionContext()
  extensionId = await getExtensionId(context)
})

test.afterAll(async () => {
  await context.close()
})

test.describe("Host grouping setting", () => {
  let popup: Page

  test.beforeEach(async () => {
    popup = await setupCleanState(context, extensionId)
    await sendMessage(popup, "toggleGroupByHost", { enabled: false })
  })

  test.afterEach(async () => {
    if (!popup.isClosed()) await popup.close()
  })

  test("toggle is enabled (not disabled) on Chrome", async () => {
    const toggle = popup.locator("#groupByHostToggle")
    await expect(toggle).toBeAttached()
    await expect(toggle).toBeEnabled()
  })

  test("no Firefox-only badge is shown for this toggle", async () => {
    const container = popup.locator("#groupByHostContainer")
    await expect(container.locator(".firefox-only-badge")).toHaveCount(0)
  })

  test("setting defaults to off", async () => {
    const toggle = popup.locator("#groupByHostToggle")
    await expect(toggle).not.toBeChecked()
  })

  test("reorders tabs within a group so same-host tabs are adjacent", async () => {
    const ruleId = await addCustomRule(popup, {
      name: "GitHub",
      domains: ["github.com"],
      color: "cyan",
      enabled: true
    })
    expect(ruleId).toBeTruthy()

    await enableAutoGroup(popup)
    await sendMessage(popup, "toggleGroupByHost", { enabled: true })

    // Interleave hosts so the group starts out unsorted: api, docs, api
    const tab1 = await createTab(context, TEST_URLS.subDomain1) // api.github.com
    const tab2 = await createTab(context, TEST_URLS.subDomain2) // docs.github.com
    const tab3 = await createTab(context, TEST_URLS.subDomain1) // api.github.com

    await waitForGroup(popup, "GitHub")

    // Re-fetch the group by title on each attempt rather than caching its id —
    // if grouping is still settling, the group can be re-created with a new id.
    await expect(async () => {
      const group = await waitForGroup(popup, "GitHub")
      const hosts = await getGroupHostsOrdered(popup, group.id)
      expect(hosts).toEqual(["api.github.com", "api.github.com", "docs.github.com"])
    }).toPass()

    await tab1.close()
    await tab2.close()
    await tab3.close()
  })
})
