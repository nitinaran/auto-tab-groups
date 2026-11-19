/**
 * Handles sorting of tab groups and moving ungrouped tabs to the end.
 * Browser is SSOT — reads current state, computes desired order, applies moves.
 *
 * Minimizes visual flash by comparing current order against desired order
 * and only moving groups that are actually out of place.
 */

import { getHostKey } from "../utils/HostKeyUtils"
import { withTabEditRetry } from "../utils/withTabEditRetry"
import { tabGroupState } from "./TabGroupState"

/**
 * Extended tabGroups API with move() — Chrome-only, not in webextension-polyfill types
 */
interface TabGroupsWithMove {
  move(groupId: number, moveProperties: { index: number }): Promise<void>
  query(
    queryInfo: Record<string, unknown>
  ): Promise<Array<{ id: number; title?: string; windowId: number }>>
}

const INDEX_PREFIX_PATTERN = /^\d+\. /

/**
 * Strips a leading index prefix (e.g., "1. GitHub" → "GitHub").
 * Returns the title unchanged if no prefix is present.
 */
export function stripIndexPrefix(title: string): string {
  return title.replace(INDEX_PREFIX_PATTERN, "")
}

/**
 * Compares current group order against desired order by group ID sequence.
 * Returns true if the groups are already in the correct order.
 */
function isAlreadySorted(
  currentOrder: Array<{ id: number }>,
  desiredOrder: Array<{ id: number }>
): boolean {
  if (currentOrder.length !== desiredOrder.length) return false
  return currentOrder.every((group, i) => group.id === desiredOrder[i].id)
}

class TabSortService {
  /**
   * Serializes every group/tab-position mutating operation below. Two of
   * these running concurrently (e.g. triggered by two tabs finishing their
   * navigation close together) would each compute moves from their own
   * independently stale snapshot, and their moves could interleave —
   * observed in practice as one operation moving a tab back into a group it
   * had already legitimately left, corrupting group membership.
   */
  private mutex: Promise<unknown> = Promise.resolve()

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn)
    this.mutex = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /**
   * Resolves which group IDs a per-group tab-sorting pass should process:
   * just the one supplied, or every group currently present in the window.
   */
  private async resolveGroupIds(windowId: number, groupId?: number): Promise<number[]> {
    if (groupId !== undefined) return [groupId]

    const allTabs = await browser.tabs.query({ windowId })
    const seen = new Set<number>()
    for (const tab of allTabs) {
      if (tab.groupId && tab.groupId !== -1) {
        seen.add(tab.groupId)
      }
    }
    return [...seen]
  }

  /**
   * Sorts tab groups alphabetically by title (A-Z or Z-A) in the current
   * window, then moves ungrouped non-pinned tabs to the end of the tab
   * strip. When indexing is enabled, applies numbered prefixes to titles.
   *
   * Optimized: compares current vs desired order and only moves groups
   * that are actually out of place to minimize visual flash.
   *
   * Chrome-only: browser.tabGroups.move() is not available in Firefox.
   */
  async sortGroups(): Promise<void> {
    return this.runExclusive(() => this._sortGroups())
  }

  private async _sortGroups(): Promise<void> {
    const tabGroups = browser.tabGroups as unknown as TabGroupsWithMove | undefined

    if (!tabGroups?.move) {
      console.log("[TabSortService] tabGroups.move unavailable (Firefox?), skipping sort")
      return
    }

    try {
      const currentWindow = await browser.windows.getCurrent()
      if (!currentWindow.id) {
        return
      }

      const queriedGroups = await tabGroups.query({ windowId: currentWindow.id })

      if (queriedGroups.length === 0) {
        return
      }

      // browser.tabGroups.query() does not return groups in visual tab-strip
      // order (it's stable by creation/ID). To compare against the current
      // layout, derive visual order from the first tab of each group in
      // tab-index order. Falls back to queried order if no tabs resolve
      // groups (e.g., in tests).
      const allTabs = await browser.tabs.query({ windowId: currentWindow.id })
      const tabsByIndex = [...allTabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      const groupById = new Map(queriedGroups.map(g => [g.id, g]))
      const visualGroupIds: number[] = []
      const seenGroupIds = new Set<number>()
      for (const tab of tabsByIndex) {
        const gid = tab.groupId
        if (gid && gid !== -1 && !seenGroupIds.has(gid) && groupById.has(gid)) {
          seenGroupIds.add(gid)
          visualGroupIds.push(gid)
        }
      }
      const groups =
        visualGroupIds.length > 0
          ? visualGroupIds
              .map(id => groupById.get(id))
              .filter((g): g is NonNullable<typeof g> => g !== undefined)
          : queriedGroups

      // Compute desired alphabetical order by stripped title, respecting
      // the configured direction ("asc" = A-Z, "desc" = Z-A)
      const directionFactor = tabGroupState.sortGroupsDirection === "desc" ? -1 : 1
      const sorted = [...groups].sort(
        (a, b) =>
          directionFactor *
          stripIndexPrefix(a.title ?? "").localeCompare(
            stripIndexPrefix(b.title ?? ""),
            undefined,
            {
              sensitivity: "base"
            }
          )
      )

      console.log(
        `[TabSortService] sortGroups: direction=${tabGroupState.sortGroupsDirection}`,
        "current=",
        groups.map(g => g.title),
        "desired=",
        sorted.map(g => g.title)
      )

      // Update index prefixes if enabled (title-only, no moves yet)
      if (tabGroupState.indexGroupTitles) {
        for (let i = 0; i < sorted.length; i++) {
          const group = sorted[i]
          const strippedTitle = stripIndexPrefix(group.title || "")
          const indexedTitle = `${i + 1}. ${strippedTitle}`

          if (group.title !== indexedTitle) {
            await withTabEditRetry(() =>
              browser.tabGroups.update(group.id, { title: indexedTitle })
            )
          }
        }
      }

      // Only move groups if the order actually changed
      if (sorted.length > 1 && !isAlreadySorted(groups, sorted)) {
        // Find groups that are out of position and only move those.
        // We move out-of-place groups to index -1 in desired order.
        // To maintain correctness, we move ALL groups from the first
        // mismatch onward — moving only individual groups could leave
        // gaps or wrong relative order.
        const firstMismatch = groups.findIndex((group, i) => group.id !== sorted[i].id)

        if (firstMismatch >= 0) {
          for (let i = firstMismatch; i < sorted.length; i++) {
            await withTabEditRetry(() => tabGroups.move(sorted[i].id, { index: -1 }))
            await new Promise(resolve => setTimeout(resolve, 10))
          }
        }
      }

      await this.moveUngroupedTabsToEnd(currentWindow.id)
    } catch (error) {
      console.error("[TabSortService] Error sorting groups:", error)
    }
  }

  /**
   * Moves all ungrouped, non-pinned tabs to the end of the tab strip.
   */
  private async moveUngroupedTabsToEnd(windowId: number): Promise<void> {
    try {
      const allTabs = await browser.tabs.query({ windowId })
      const ungroupedTabs = allTabs.filter(
        tab => !tab.pinned && (!tab.groupId || tab.groupId === -1)
      )

      for (const tab of ungroupedTabs) {
        if (tab.id !== undefined) {
          await withTabEditRetry(() => browser.tabs.move(tab.id!, { index: -1 }))
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
    } catch (error) {
      console.error("[TabSortService] Error moving ungrouped tabs:", error)
    }
  }

  /**
   * Removes all index prefixes from group titles in the current window.
   * Called when the indexing feature is disabled.
   */
  async stripAllIndexPrefixes(): Promise<void> {
    try {
      if (!browser.tabGroups) return

      const currentWindow = await browser.windows.getCurrent()
      if (!currentWindow.id) return

      const groups = await browser.tabGroups.query({ windowId: currentWindow.id })

      for (const group of groups) {
        const strippedTitle = stripIndexPrefix(group.title || "")
        if (group.title !== strippedTitle) {
          await withTabEditRetry(() => browser.tabGroups.update(group.id, { title: strippedTitle }))
        }
      }
    } catch (error) {
      console.error("[TabSortService] Error stripping index prefixes:", error)
    }
  }

  /**
   * Reorders tabs within each tab group so tabs from the same Firefox
   * Multi-Account Container (cookieStoreId) are kept together.
   *
   * Works by stable-sorting tabs within each group by their cookieStoreId,
   * then moving any that are out of place to their target absolute index.
   * On Chrome (no cookieStoreId), all tabs sort to the empty string and
   * the order never changes — effectively a no-op.
   *
   * If groupId is supplied, only that group is reordered; otherwise every
   * group in the current window is processed.
   */
  async sortGroupTabsByContainer(groupId?: number): Promise<void> {
    return this.runExclusive(async () => {
      try {
        const currentWindow = await browser.windows.getCurrent()
        if (!currentWindow.id) return
        const windowId = currentWindow.id

        const groupIds = await this.resolveGroupIds(windowId, groupId)

        for (const gId of groupIds) {
          // Re-query this group's tabs fresh right before acting on it, rather
          // than reusing a snapshot taken earlier — minimizes the window for a
          // concurrent operation (e.g. another tab being grouped elsewhere) to
          // change membership out from under us.
          const groupTabs = (await browser.tabs.query({ windowId, groupId: gId }))
            .filter(tab => tab.groupId === gId)
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))

          if (groupTabs.length <= 1) continue

          // Stable sort by cookieStoreId — tabs without one (Chrome) all share
          // the empty string so their relative order is preserved unchanged.
          const desiredOrder = [...groupTabs].sort((a, b) => {
            const aId = (a as { cookieStoreId?: string }).cookieStoreId ?? ""
            const bId = (b as { cookieStoreId?: string }).cookieStoreId ?? ""
            return aId.localeCompare(bId)
          })

          const alreadySorted = groupTabs.every((tab, i) => tab.id === desiredOrder[i].id)
          if (alreadySorted) continue

          const startIdx = groupTabs[0].index ?? 0

          for (let i = 0; i < desiredOrder.length; i++) {
            const tab = desiredOrder[i]
            if (tab.id === undefined) continue

            // Re-query to get the tab's current state after previous moves shifted things.
            const currentTab = await browser.tabs.get(tab.id)

            // The tab may have left this group since the snapshot above (e.g.
            // a concurrent grouping operation elsewhere) — forcing it to an
            // absolute index here would re-merge it into this group. Skip it.
            if (currentTab.groupId !== gId) continue

            const targetIndex = startIdx + i

            if (currentTab.index !== targetIndex) {
              await withTabEditRetry(() => browser.tabs.move(tab.id!, { index: targetIndex }))
              await new Promise(resolve => setTimeout(resolve, 10))
            }
          }
        }
      } catch (error) {
        console.error("[TabSortService] Error sorting tabs by container:", error)
      }
    })
  }

  /**
   * Applies container sorting if the setting is enabled.
   * Called after grouping operations complete.
   */
  async applyContainerSorting(): Promise<void> {
    if (tabGroupState.groupByContainer) {
      await this.sortGroupTabsByContainer()
    }
  }

  /**
   * Reorders tabs within each tab group so tabs with the same hostname
   * are kept together.
   *
   * Works by stable-sorting tabs within each group by their host key (the
   * label of the first matching hostKeyRules entry, otherwise the URL's
   * hostname — see getHostKey), then moving any that are out of place to
   * their target absolute index.
   *
   * If groupId is supplied, only that group is reordered; otherwise every
   * group in the current window is processed.
   */
  async sortGroupTabsByHost(groupId?: number): Promise<void> {
    return this.runExclusive(async () => {
      try {
        const currentWindow = await browser.windows.getCurrent()
        if (!currentWindow.id) return
        const windowId = currentWindow.id

        const groupIds = await this.resolveGroupIds(windowId, groupId)

        for (const gId of groupIds) {
          // Re-query this group's tabs fresh right before acting on it, rather
          // than reusing a snapshot taken earlier — minimizes the window for a
          // concurrent operation (e.g. another tab being grouped elsewhere) to
          // change membership out from under us.
          const groupTabs = (await browser.tabs.query({ windowId, groupId: gId }))
            .filter(tab => tab.groupId === gId)
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))

          if (groupTabs.length <= 1) continue

          // Stable sort by host key — tabs with the same host keep their
          // relative order, and end up contiguous.
          const desiredOrder = groupTabs
            .map(tab => ({ tab, key: getHostKey(tab.url, tabGroupState.hostKeyRules) }))
            .sort((a, b) => a.key.localeCompare(b.key))
            .map(({ tab }) => tab)

          const alreadySorted = groupTabs.every((tab, i) => tab.id === desiredOrder[i].id)
          if (alreadySorted) continue

          const startIdx = groupTabs[0].index ?? 0

          for (let i = 0; i < desiredOrder.length; i++) {
            const tab = desiredOrder[i]
            if (tab.id === undefined) continue

            // Re-query to get the tab's current state after previous moves shifted things.
            const currentTab = await browser.tabs.get(tab.id)

            // The tab may have left this group since the snapshot above (e.g.
            // a concurrent grouping operation elsewhere) — forcing it to an
            // absolute index here would re-merge it into this group. Skip it.
            if (currentTab.groupId !== gId) continue

            const targetIndex = startIdx + i

            if (currentTab.index !== targetIndex) {
              await withTabEditRetry(() => browser.tabs.move(tab.id!, { index: targetIndex }))
              await new Promise(resolve => setTimeout(resolve, 10))
            }
          }
        }
      } catch (error) {
        console.error("[TabSortService] Error sorting tabs by host:", error)
      }
    })
  }

  /**
   * Applies host sorting if the setting is enabled.
   * Called after grouping operations complete.
   */
  async applyHostSorting(): Promise<void> {
    if (tabGroupState.groupByHost) {
      await this.sortGroupTabsByHost()
    }
  }

  /**
   * Applies sorting if the setting is enabled.
   * Called after grouping operations complete.
   */
  async applySorting(): Promise<void> {
    if (tabGroupState.sortGroupsAlphabetically) {
      await this.sortGroups()
    }
    await this.applyContainerSorting()
    await this.applyHostSorting()
  }
}

export const tabSortService = new TabSortService()
