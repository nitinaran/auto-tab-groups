import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mockBrowser } from "./setup"

vi.mock("../utils/storage", () => ({
  loadAllStorage: vi.fn().mockResolvedValue({}),
  saveAllStorage: vi.fn().mockResolvedValue(undefined),
  getGroupColor: vi.fn(),
  updateGroupColor: vi.fn(),
  groupColorMapping: { getValue: vi.fn().mockResolvedValue({}) }
}))

import { tabGroupState } from "../services/TabGroupState"
import { stripIndexPrefix, tabSortService } from "../services/TabSortService"
import { DEFAULT_STATE } from "../types/storage"

interface FakeTab {
  id: number
  groupId: number
  url?: string
  cookieStoreId?: string
}

/**
 * A stateful stand-in for the browser's tab strip. Unlike canned query
 * results it applies moves, so tests can assert the final order. It also
 * mimics the browser adopting a tab that is moved strictly inside another
 * group's range, which is the behaviour the sort has to defend against.
 */
function installTabStrip(initial: FakeTab[]) {
  const strip: FakeTab[] = initial.map(tab => ({ ...tab }))
  let afterFirstGroupQueryHook: (() => void) | undefined

  const view = () => strip.map((tab, index) => ({ ...tab, index }))

  mockBrowser.tabs.query.mockImplementation(async (query: { groupId?: number }) => {
    const result = view().filter(
      tab => query.groupId === undefined || tab.groupId === query.groupId
    )
    if (afterFirstGroupQueryHook && query.groupId !== undefined) {
      const hook = afterFirstGroupQueryHook
      afterFirstGroupQueryHook = undefined
      hook()
    }
    return result
  })

  mockBrowser.tabs.get.mockImplementation(async (id: number) => {
    const tab = view().find(candidate => candidate.id === id)
    if (!tab) throw new Error(`No tab with id ${id}`)
    return tab
  })

  mockBrowser.tabs.move.mockImplementation(async (id: number, { index }: { index: number }) => {
    const from = strip.findIndex(tab => tab.id === id)
    const [tab] = strip.splice(from, 1)
    strip.splice(index, 0, tab)

    const before = strip[index - 1]
    const after = strip[index + 1]
    if (before && after && before.groupId !== -1 && before.groupId === after.groupId) {
      tab.groupId = before.groupId
    }
    return {}
  })

  mockBrowser.tabs.group.mockImplementation(
    async ({ tabIds, groupId }: { tabIds: number[]; groupId: number }) => {
      for (const tab of strip) {
        if (tabIds.includes(tab.id)) tab.groupId = groupId
      }
      return groupId
    }
  )

  return {
    order: (groupId?: number) =>
      strip.filter(tab => groupId === undefined || tab.groupId === groupId).map(tab => tab.id),
    groupOf: (id: number) => strip.find(tab => tab.id === id)?.groupId,
    setGroup: (id: number, groupId: number) => {
      const tab = strip.find(candidate => candidate.id === id)
      if (tab) tab.groupId = groupId
    },
    insertAt: (index: number, tab: FakeTab) => {
      strip.splice(index, 0, { ...tab })
    },
    /** Runs once, right after the first per-group tab query returns */
    afterFirstGroupQuery: (hook: () => void) => {
      afterFirstGroupQueryHook = hook
    }
  }
}

/** Drop the fake's implementations so later tests start from a blank API */
function resetTabApi(): void {
  for (const fn of [
    mockBrowser.tabs.query,
    mockBrowser.tabs.get,
    mockBrowser.tabs.move,
    mockBrowser.tabs.group
  ]) {
    fn.mockReset()
  }
  mockBrowser.tabs.query.mockResolvedValue([])
  mockBrowser.tabs.get.mockResolvedValue({})
  mockBrowser.tabs.move.mockResolvedValue({})
  mockBrowser.tabs.group.mockResolvedValue(1)
}

describe("TabSortService", () => {
  beforeEach(() => {
    tabGroupState.updateFromStorage(DEFAULT_STATE)
    vi.clearAllMocks()
    mockBrowser.windows.getCurrent.mockResolvedValue({ id: 1 })
  })

  describe("stripIndexPrefix", () => {
    it("should strip a single-digit prefix", () => {
      expect(stripIndexPrefix("1. GitHub")).toBe("GitHub")
    })

    it("should strip a multi-digit prefix", () => {
      expect(stripIndexPrefix("10. Long Name")).toBe("Long Name")
    })

    it("should return unchanged title when no prefix exists", () => {
      expect(stripIndexPrefix("GitHub")).toBe("GitHub")
    })

    it("should return empty string unchanged", () => {
      expect(stripIndexPrefix("")).toBe("")
    })

    it("should not strip partial patterns like '1.GitHub' (no space)", () => {
      expect(stripIndexPrefix("1.GitHub")).toBe("1.GitHub")
    })

    it("should not strip non-numeric prefixes", () => {
      expect(stripIndexPrefix("a. Something")).toBe("a. Something")
    })
  })

  describe("sortGroups", () => {
    it("should sort groups alphabetically by title", async () => {
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "GitHub", windowId: 1 },
        { id: 2, title: "Amazon", windowId: 1 },
        { id: 3, title: "Docs", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Should move in alphabetical order: Amazon, Docs, GitHub
      expect(mockBrowser.tabGroups.move).toHaveBeenCalledTimes(3)
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(1, 2, { index: -1 })
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(2, 3, { index: -1 })
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(3, 1, { index: -1 })
    })

    it("should be case-insensitive when sorting", async () => {
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "zebra", windowId: 1 },
        { id: 2, title: "Apple", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Apple before zebra (case-insensitive)
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(1, 2, { index: -1 })
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(2, 1, { index: -1 })
    })

    it("should sort by stripped title when groups already have index prefixes", async () => {
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "2. GitHub", windowId: 1 },
        { id: 2, title: "1. Amazon", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Should sort by stripped title: Amazon before GitHub
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(1, 2, { index: -1 })
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(2, 1, { index: -1 })
    })

    it("should not move when there is only one group", async () => {
      mockBrowser.tabGroups.query.mockResolvedValue([{ id: 1, title: "Solo", windowId: 1 }])

      await tabSortService.sortGroups()

      expect(mockBrowser.tabGroups.move).not.toHaveBeenCalled()
    })

    it("should not sort when there are no groups", async () => {
      mockBrowser.tabGroups.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      expect(mockBrowser.tabGroups.move).not.toHaveBeenCalled()
    })

    it("should move ungrouped non-pinned tabs to the end after sorting groups", async () => {
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "A Group", windowId: 1 },
        { id: 2, title: "B Group", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 10, groupId: 1, pinned: false },
        { id: 11, groupId: -1, pinned: false },
        { id: 12, groupId: 2, pinned: false },
        { id: 13, groupId: -1, pinned: false },
        { id: 14, groupId: -1, pinned: true } // pinned — should NOT be moved
      ])

      await tabSortService.sortGroups()

      // After group moves, ungrouped non-pinned tabs (11, 13) should be moved to end
      expect(mockBrowser.tabs.move).toHaveBeenCalledWith(11, { index: -1 })
      expect(mockBrowser.tabs.move).toHaveBeenCalledWith(13, { index: -1 })
      // Pinned tab should NOT be moved
      expect(mockBrowser.tabs.move).not.toHaveBeenCalledWith(14, { index: -1 })
    })

    it("should not move ungrouped tabs that are pinned", async () => {
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "Group", windowId: 1 },
        { id: 2, title: "Another", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 10, groupId: -1, pinned: true },
        { id: 11, groupId: -1, pinned: true }
      ])

      await tabSortService.sortGroups()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should handle groups with undefined titles", async () => {
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 2, title: "Alpha", windowId: 1 },
        { id: 1, title: undefined, windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Empty string sorts before "Alpha", so order should be [1, 2]
      // Current is [2, 1] — needs to move both from mismatch at index 0
      expect(mockBrowser.tabGroups.move).toHaveBeenCalledTimes(2)
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(1, 1, { index: -1 })
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(2, 2, { index: -1 })
    })

    it("should skip moves when groups are already in correct order", async () => {
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 2, title: "Amazon", windowId: 1 },
        { id: 3, title: "Docs", windowId: 1 },
        { id: 1, title: "GitHub", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Already in alphabetical order — no moves needed
      expect(mockBrowser.tabGroups.move).not.toHaveBeenCalled()
    })

    it("should only move groups from the first mismatch onward", async () => {
      // Current: Amazon(2), GitHub(1), Docs(3)
      // Desired: Amazon(2), Docs(3), GitHub(1)
      // First mismatch at index 1: only move Docs and GitHub
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 2, title: "Amazon", windowId: 1 },
        { id: 1, title: "GitHub", windowId: 1 },
        { id: 3, title: "Docs", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      expect(mockBrowser.tabGroups.move).toHaveBeenCalledTimes(2)
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(1, 3, { index: -1 })
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(2, 1, { index: -1 })
    })

    it("should handle errors gracefully without throwing", async () => {
      mockBrowser.tabGroups.query.mockRejectedValue(new Error("API error"))

      await expect(tabSortService.sortGroups()).resolves.toBeUndefined()
    })
  })

  describe("sortGroups with Z-A direction", () => {
    it("should sort groups in reverse alphabetical order when direction is desc", async () => {
      tabGroupState.sortGroupsDirection = "desc"
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "Amazon", windowId: 1 },
        { id: 2, title: "GitHub", windowId: 1 },
        { id: 3, title: "Docs", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Z-A order: GitHub(2), Docs(3), Amazon(1)
      expect(mockBrowser.tabGroups.move).toHaveBeenCalledTimes(3)
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(1, 2, { index: -1 })
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(2, 3, { index: -1 })
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(3, 1, { index: -1 })
    })

    it("should apply index prefixes in Z-A order when indexing is enabled", async () => {
      tabGroupState.sortGroupsDirection = "desc"
      tabGroupState.indexGroupTitles = true
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "Amazon", windowId: 1 },
        { id: 2, title: "GitHub", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Z-A order means GitHub is 1, Amazon is 2
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(2, { title: "1. GitHub" })
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(1, { title: "2. Amazon" })
    })

    it("should skip moves when groups are already in Z-A order", async () => {
      tabGroupState.sortGroupsDirection = "desc"
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "GitHub", windowId: 1 },
        { id: 2, title: "Docs", windowId: 1 },
        { id: 3, title: "Amazon", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      expect(mockBrowser.tabGroups.move).not.toHaveBeenCalled()
    })

    it("should fall back to A-Z order when direction is asc", async () => {
      tabGroupState.sortGroupsDirection = "asc"
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "GitHub", windowId: 1 },
        { id: 2, title: "Amazon", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // A-Z: Amazon(2), GitHub(1)
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(1, 2, { index: -1 })
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(2, 1, { index: -1 })
    })

    it("should flip A-Z to Z-A when tab-strip order differs from tabGroups.query order", async () => {
      // Regression: tabGroups.query() is stable by creation/ID, not visual
      // tab-strip order. Relying on it caused Z-A (and reverse flips) to no-op
      // after an initial sort had already been applied.
      tabGroupState.sortGroupsDirection = "desc"
      // Chrome returned groups in creation order: Youtube(1) then Google(2)
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "Youtube", windowId: 1 },
        { id: 2, title: "Google", windowId: 1 }
      ])
      // But visually (after a prior A-Z sort) the strip is Google, Youtube
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 100, groupId: 2, pinned: false, index: 0 },
        { id: 101, groupId: 1, pinned: false, index: 1 }
      ])

      await tabSortService.sortGroups()

      // Visual order is [Google(2), Youtube(1)], desired Z-A is [Youtube(1), Google(2)] —
      // every position differs, so both groups get moved.
      expect(mockBrowser.tabGroups.move).toHaveBeenCalledTimes(2)
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(1, 1, { index: -1 })
      expect(mockBrowser.tabGroups.move).toHaveBeenNthCalledWith(2, 2, { index: -1 })
    })
  })

  describe("sortGroups with indexing", () => {
    it("should apply index prefixes after sorting when indexGroupTitles is enabled", async () => {
      tabGroupState.indexGroupTitles = true
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "GitHub", windowId: 1 },
        { id: 2, title: "Amazon", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Should update titles with index prefixes in alphabetical order
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(2, { title: "1. Amazon" })
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(1, { title: "2. GitHub" })
    })

    it("should not apply index prefixes when indexGroupTitles is disabled", async () => {
      tabGroupState.indexGroupTitles = false
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "GitHub", windowId: 1 },
        { id: 2, title: "Amazon", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      expect(mockBrowser.tabGroups.update).not.toHaveBeenCalled()
    })

    it("should apply index prefix to single group when indexGroupTitles is enabled", async () => {
      tabGroupState.indexGroupTitles = true
      mockBrowser.tabGroups.query.mockResolvedValue([{ id: 1, title: "Solo", windowId: 1 }])

      await tabSortService.sortGroups()

      // Single group should still get prefix, but no move
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(1, { title: "1. Solo" })
      expect(mockBrowser.tabGroups.move).not.toHaveBeenCalled()
    })

    it("should correctly re-index when a new group is added among already-indexed groups", async () => {
      tabGroupState.indexGroupTitles = true
      // Simulate: existing groups are already indexed, a new "Extensions" group was just created
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "1. AI", windowId: 1 },
        { id: 2, title: "2. Comms", windowId: 1 },
        { id: 3, title: "3. Github", windowId: 1 },
        { id: 4, title: "4. System", windowId: 1 },
        { id: 5, title: "Extensions", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Sorted alphabetically: AI(1), Comms(2), Extensions(3), Github(4), System(5)
      // "1. AI" and "2. Comms" are already correct, so no update needed for those
      // Extensions gets "3.", Github shifts from "3." to "4.", System from "4." to "5."
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(5, { title: "3. Extensions" })
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(3, { title: "4. Github" })
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(4, { title: "5. System" })
      // AI and Comms already have correct prefixes — should NOT be updated
      expect(mockBrowser.tabGroups.update).not.toHaveBeenCalledWith(1, expect.anything())
      expect(mockBrowser.tabGroups.update).not.toHaveBeenCalledWith(2, expect.anything())
    })

    it("should strip old prefixes before re-indexing", async () => {
      tabGroupState.indexGroupTitles = true
      // Groups with stale/wrong indices
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "3. AI", windowId: 1 },
        { id: 2, title: "1. Comms", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Should assign correct indices based on alphabetical order
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(1, { title: "1. AI" })
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(2, { title: "2. Comms" })
    })

    it("should skip title update when title already has correct prefix", async () => {
      tabGroupState.indexGroupTitles = true
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "1. AI", windowId: 1 },
        { id: 2, title: "2. Comms", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Titles already correct — no update calls needed
      expect(mockBrowser.tabGroups.update).not.toHaveBeenCalled()
    })

    it("should correctly index groups with the same starting letter", async () => {
      tabGroupState.indexGroupTitles = true
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "Assets", windowId: 1 },
        { id: 2, title: "AI", windowId: 1 },
        { id: 3, title: "Amazon", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // Alphabetical: AI, Amazon, Assets
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(2, { title: "1. AI" })
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(3, { title: "2. Amazon" })
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(1, { title: "3. Assets" })
    })

    it("should update titles before moving groups", async () => {
      tabGroupState.indexGroupTitles = true
      const callOrder: string[] = []
      mockBrowser.tabGroups.update.mockImplementation(() => {
        callOrder.push("update")
        return Promise.resolve({})
      })
      mockBrowser.tabGroups.move.mockImplementation(() => {
        callOrder.push("move")
        return Promise.resolve(undefined)
      })
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "B", windowId: 1 },
        { id: 2, title: "A", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.sortGroups()

      // All updates should come before all moves
      const firstMove = callOrder.indexOf("move")
      const lastUpdate = callOrder.lastIndexOf("update")
      expect(lastUpdate).toBeLessThan(firstMove)
    })
  })

  describe("stripAllIndexPrefixes", () => {
    it("should remove prefixes from all groups", async () => {
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "1. AI", windowId: 1 },
        { id: 2, title: "2. Communications", windowId: 1 }
      ])

      await tabSortService.stripAllIndexPrefixes()

      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(1, { title: "AI" })
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(2, {
        title: "Communications"
      })
    })

    it("should skip groups that have no prefix", async () => {
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "AI", windowId: 1 },
        { id: 2, title: "3. Communications", windowId: 1 }
      ])

      await tabSortService.stripAllIndexPrefixes()

      expect(mockBrowser.tabGroups.update).toHaveBeenCalledTimes(1)
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(2, {
        title: "Communications"
      })
    })

    it("should handle errors gracefully", async () => {
      mockBrowser.tabGroups.query.mockRejectedValue(new Error("API error"))

      await expect(tabSortService.stripAllIndexPrefixes()).resolves.toBeUndefined()
    })
  })

  describe("applySorting", () => {
    it("should call sortGroups when sortGroupsAlphabetically is enabled", async () => {
      tabGroupState.sortGroupsAlphabetically = true
      tabGroupState.groupByContainer = false
      mockBrowser.tabGroups.query.mockResolvedValue([
        { id: 1, title: "B", windowId: 1 },
        { id: 2, title: "A", windowId: 1 }
      ])
      mockBrowser.tabs.query.mockResolvedValue([])

      await tabSortService.applySorting()

      expect(mockBrowser.tabGroups.move).toHaveBeenCalled()
    })

    it("should not call sortGroups when sortGroupsAlphabetically is disabled", async () => {
      tabGroupState.sortGroupsAlphabetically = false
      tabGroupState.groupByContainer = false

      await tabSortService.applySorting()

      expect(mockBrowser.tabGroups.move).not.toHaveBeenCalled()
    })

    it("should call sortGroupTabsByContainer when groupByContainer is enabled", async () => {
      tabGroupState.sortGroupsAlphabetically = false
      tabGroupState.groupByContainer = true
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 10, index: 0, cookieStoreId: "firefox-container-2" },
        { id: 2, groupId: 10, index: 1, cookieStoreId: "firefox-container-1" }
      ])
      mockBrowser.tabs.get
        .mockResolvedValueOnce({ index: 1, groupId: 10 }) // tab 2 current position before move
        .mockResolvedValueOnce({ index: 1, groupId: 10 }) // tab 1 current position after tab 2 moved

      await tabSortService.applySorting()

      // container-1 should come before container-2, so tab 2 moves to index 0
      expect(mockBrowser.tabs.move).toHaveBeenCalledWith(2, { index: 0 })
    })

    it("should not call sortGroupTabsByContainer when groupByContainer is disabled", async () => {
      tabGroupState.sortGroupsAlphabetically = false
      tabGroupState.groupByContainer = false
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 10, index: 0, cookieStoreId: "firefox-container-2" },
        { id: 2, groupId: 10, index: 1, cookieStoreId: "firefox-container-1" }
      ])

      await tabSortService.applySorting()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should call sortGroupTabsByHost when groupByHost is enabled", async () => {
      tabGroupState.sortGroupsAlphabetically = false
      tabGroupState.groupByContainer = false
      tabGroupState.groupByHost = true
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 10, index: 0, url: "https://b.example.com/" },
        { id: 2, groupId: 10, index: 1, url: "https://a.example.com/" }
      ])
      mockBrowser.tabs.get
        .mockResolvedValueOnce({ index: 1, groupId: 10 }) // tab 2 current position before move
        .mockResolvedValueOnce({ index: 1, groupId: 10 }) // tab 1 current position after tab 2 moved

      await tabSortService.applySorting()

      // a.example.com should come before b.example.com, so tab 2 moves to index 0
      expect(mockBrowser.tabs.move).toHaveBeenCalledWith(2, { index: 0 })
    })

    it("should not call sortGroupTabsByHost when groupByHost is disabled", async () => {
      tabGroupState.sortGroupsAlphabetically = false
      tabGroupState.groupByContainer = false
      tabGroupState.groupByHost = false
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 10, index: 0, url: "https://b.example.com/" },
        { id: 2, groupId: 10, index: 1, url: "https://a.example.com/" }
      ])

      await tabSortService.applySorting()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })
  })

  describe("sortGroupTabsByContainer", () => {
    beforeEach(() => {
      tabGroupState.groupByContainer = true
    })

    afterEach(resetTabApi)

    const c1 = "firefox-container-1"
    const c2 = "firefox-container-2"

    it("should reorder tabs so same-container tabs are adjacent", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, cookieStoreId: c2 },
        { id: 2, groupId: 10, cookieStoreId: c1 }
      ])

      await tabSortService.sortGroupTabsByContainer()

      expect(strip.order()).toEqual([2, 1])
    })

    it("should not move tabs already in the correct container order", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, cookieStoreId: c1 },
        { id: 2, groupId: 10, cookieStoreId: c2 }
      ])

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
      expect(strip.order()).toEqual([1, 2])
    })

    it("should leave a single-tab group untouched", async () => {
      installTabStrip([{ id: 1, groupId: 10, cookieStoreId: c1 }])

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should be a no-op on Chrome tabs that have no cookieStoreId", async () => {
      installTabStrip([
        { id: 1, groupId: 10 },
        { id: 2, groupId: 10 },
        { id: 3, groupId: 10 }
      ])

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should process every group in the window when no groupId is given", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, cookieStoreId: c2 },
        { id: 2, groupId: 10, cookieStoreId: c1 },
        { id: 3, groupId: 20, cookieStoreId: c2 },
        { id: 4, groupId: 20, cookieStoreId: c1 }
      ])

      await tabSortService.sortGroupTabsByContainer()

      expect(strip.order(10)).toEqual([2, 1])
      expect(strip.order(20)).toEqual([4, 3])
    })

    it("should only sort the specified group when groupId is given", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, cookieStoreId: c2 },
        { id: 2, groupId: 10, cookieStoreId: c1 },
        { id: 3, groupId: 20, cookieStoreId: c2 },
        { id: 4, groupId: 20, cookieStoreId: c1 }
      ])

      await tabSortService.sortGroupTabsByContainer(10)

      expect(strip.order(10)).toEqual([2, 1])
      expect(strip.order(20)).toEqual([3, 4])
    })

    it("should skip ungrouped tabs (groupId === -1)", async () => {
      installTabStrip([
        { id: 1, groupId: -1, cookieStoreId: c2 },
        { id: 2, groupId: -1, cookieStoreId: c1 }
      ])

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should keep tabs with the same container in their original relative order (stable sort)", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, cookieStoreId: c1 },
        { id: 2, groupId: 10, cookieStoreId: c2 },
        { id: 3, groupId: 10, cookieStoreId: c1 },
        { id: 4, groupId: 10, cookieStoreId: c2 }
      ])

      await tabSortService.sortGroupTabsByContainer()

      expect(strip.order()).toEqual([1, 3, 2, 4])
      expect(mockBrowser.tabs.move).toHaveBeenCalledTimes(1)
    })

    it("should skip a tab that has left the group since the snapshot was taken", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, cookieStoreId: c2 },
        { id: 2, groupId: 10, cookieStoreId: c1 }
      ])
      // Tab 2 is reassigned to another group right after the snapshot —
      // moving it now would forcibly pull it back into group 10.
      strip.afterFirstGroupQuery(() => strip.setGroup(2, 99))

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
      expect(strip.groupOf(2)).toBe(99)
    })

    it("should keep every tab in its group when a neighbouring group grows mid-sort", async () => {
      // Group 1 is just before group 2. A tab joins group 1 after the snapshot
      // was taken, shifting where group 2 starts. A move to the stale start
      // index would land inside group 1 and the browser would adopt the tab.
      const strip = installTabStrip([
        { id: 100, groupId: 1 },
        { id: 1, groupId: 2, cookieStoreId: c2 },
        { id: 2, groupId: 2, cookieStoreId: c1 }
      ])
      strip.afterFirstGroupQuery(() => strip.insertAt(1, { id: 101, groupId: 1 }))

      await tabSortService.sortGroupTabsByContainer(2)

      expect(strip.order(2)).toEqual([2, 1])
      expect(strip.order(1)).toEqual([100, 101])
    })

    it("should put a tab back if the browser pulls it into another group anyway", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, cookieStoreId: c2 },
        { id: 2, groupId: 10, cookieStoreId: c1 }
      ])
      mockBrowser.tabs.move.mockImplementationOnce(async (id: number) => {
        strip.setGroup(id, 99)
        return {}
      })

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.group).toHaveBeenCalledWith({ tabIds: [2], groupId: 10 })
      expect(strip.groupOf(2)).toBe(10)
    })

    it("should handle errors gracefully without throwing", async () => {
      mockBrowser.tabs.query.mockRejectedValue(new Error("API error"))

      await expect(tabSortService.sortGroupTabsByContainer()).resolves.toBeUndefined()
    })

    it("should do nothing when window has no id", async () => {
      mockBrowser.windows.getCurrent.mockResolvedValueOnce({ id: undefined })

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.query).not.toHaveBeenCalled()
    })
  })

  describe("sortGroupTabsByHost", () => {
    beforeEach(() => {
      tabGroupState.groupByHost = true
    })

    afterEach(resetTabApi)

    it("should reorder tabs so same-host tabs are adjacent", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, url: "https://b.example.com/" },
        { id: 2, groupId: 10, url: "https://a.example.com/" }
      ])

      await tabSortService.sortGroupTabsByHost()

      expect(strip.order()).toEqual([2, 1])
    })

    it("should not move tabs already in the correct host order", async () => {
      installTabStrip([
        { id: 1, groupId: 10, url: "https://a.example.com/" },
        { id: 2, groupId: 10, url: "https://b.example.com/" }
      ])

      await tabSortService.sortGroupTabsByHost()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should leave a single-tab group untouched", async () => {
      installTabStrip([{ id: 1, groupId: 10, url: "https://a.example.com/" }])

      await tabSortService.sortGroupTabsByHost()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should treat different subdomains as different hosts", async () => {
      // docs.example.com sorts before mail.example.com
      const strip = installTabStrip([
        { id: 1, groupId: 10, url: "https://mail.example.com/" },
        { id: 2, groupId: 10, url: "https://docs.example.com/" }
      ])

      await tabSortService.sortGroupTabsByHost()

      expect(strip.order()).toEqual([2, 1])
    })

    it("should keep Jira and Confluence tabs on the same Atlassian host separate (default rules)", async () => {
      // Confluence, Jira, Confluence — interleaved on one hostname. The two
      // Confluence tabs must end up adjacent, with Jira after them.
      const strip = installTabStrip([
        { id: 1, groupId: 10, url: "https://viavi.atlassian.net/wiki/spaces/ENG" },
        { id: 2, groupId: 10, url: "https://viavi.atlassian.net/browse/ABC-1" },
        { id: 3, groupId: 10, url: "https://viavi.atlassian.net/wiki" }
      ])

      await tabSortService.sortGroupTabsByHost()

      expect(strip.order()).toEqual([1, 3, 2])
      expect(mockBrowser.tabs.move).toHaveBeenCalledTimes(1)
    })

    it("should use the configured hostKeyRules to merge and split sites by path", async () => {
      tabGroupState.hostKeyRules = [
        { pattern: "intranet.example.com/docs", label: "Docs" },
        { pattern: "intranet.example.com/help", label: "Docs" },
        { pattern: "intranet.example.com", label: "Portal" }
      ]
      // Docs, Portal, Docs (via /help) — the two Docs tabs must end up adjacent
      const strip = installTabStrip([
        { id: 1, groupId: 10, url: "https://intranet.example.com/docs/a" },
        { id: 2, groupId: 10, url: "https://intranet.example.com/home" },
        { id: 3, groupId: 10, url: "https://intranet.example.com/help/b" }
      ])

      await tabSortService.sortGroupTabsByHost()

      expect(strip.order()).toEqual([1, 3, 2])
    })

    it("should fall back to plain hostname sorting when hostKeyRules is empty", async () => {
      tabGroupState.hostKeyRules = []
      installTabStrip([
        { id: 1, groupId: 10, url: "https://viavi.atlassian.net/wiki" },
        { id: 2, groupId: 10, url: "https://viavi.atlassian.net/jira" }
      ])

      await tabSortService.sortGroupTabsByHost()

      // Same hostname, so nothing to reorder
      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should treat tabs with no URL as a shared empty host and leave them unmoved", async () => {
      installTabStrip([
        { id: 1, groupId: 10 },
        { id: 2, groupId: 10 },
        { id: 3, groupId: 10 }
      ])

      await tabSortService.sortGroupTabsByHost()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should process every group in the window when no groupId is given", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, url: "https://b.example.com/" },
        { id: 2, groupId: 10, url: "https://a.example.com/" },
        { id: 3, groupId: 20, url: "https://b.example.com/" },
        { id: 4, groupId: 20, url: "https://a.example.com/" }
      ])

      await tabSortService.sortGroupTabsByHost()

      expect(strip.order(10)).toEqual([2, 1])
      expect(strip.order(20)).toEqual([4, 3])
    })

    it("should only sort the specified group when groupId is given", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, url: "https://b.example.com/" },
        { id: 2, groupId: 10, url: "https://a.example.com/" },
        { id: 3, groupId: 20, url: "https://b.example.com/" },
        { id: 4, groupId: 20, url: "https://a.example.com/" }
      ])

      await tabSortService.sortGroupTabsByHost(10)

      expect(strip.order(10)).toEqual([2, 1])
      expect(strip.order(20)).toEqual([3, 4])
    })

    it("should skip ungrouped tabs (groupId === -1)", async () => {
      installTabStrip([
        { id: 1, groupId: -1, url: "https://b.example.com/" },
        { id: 2, groupId: -1, url: "https://a.example.com/" }
      ])

      await tabSortService.sortGroupTabsByHost()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should keep tabs with the same host in their original relative order (stable sort)", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, url: "https://a.example.com/" },
        { id: 2, groupId: 10, url: "https://b.example.com/" },
        { id: 3, groupId: 10, url: "https://a.example.com/" },
        { id: 4, groupId: 10, url: "https://b.example.com/" }
      ])

      await tabSortService.sortGroupTabsByHost()

      expect(strip.order()).toEqual([1, 3, 2, 4])
      expect(mockBrowser.tabs.move).toHaveBeenCalledTimes(1)
    })

    it("should skip a tab that has left the group since the snapshot was taken", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, url: "https://b.example.com/" },
        { id: 2, groupId: 10, url: "https://a.example.com/" }
      ])
      // Tab 2 is reassigned to another group right after the snapshot —
      // moving it now would forcibly pull it back into group 10.
      strip.afterFirstGroupQuery(() => strip.setGroup(2, 99))

      await tabSortService.sortGroupTabsByHost()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
      expect(strip.groupOf(2)).toBe(99)
    })

    it("should keep every tab in its group when a neighbouring group grows mid-sort", async () => {
      // Group 1 is just before group 2. A tab joins group 1 after the snapshot
      // was taken, shifting where group 2 starts. A move to the stale start
      // index would land inside group 1 and the browser would adopt the tab.
      const strip = installTabStrip([
        { id: 100, groupId: 1, url: "about:blank" },
        { id: 1, groupId: 2, url: "https://b.example.com/" },
        { id: 2, groupId: 2, url: "https://a.example.com/" }
      ])
      strip.afterFirstGroupQuery(() =>
        strip.insertAt(1, { id: 101, groupId: 1, url: "about:blank" })
      )

      await tabSortService.sortGroupTabsByHost(2)

      expect(strip.order(2)).toEqual([2, 1])
      expect(strip.order(1)).toEqual([100, 101])
    })

    it("should put a tab back if the browser pulls it into another group anyway", async () => {
      const strip = installTabStrip([
        { id: 1, groupId: 10, url: "https://b.example.com/" },
        { id: 2, groupId: 10, url: "https://a.example.com/" }
      ])
      mockBrowser.tabs.move.mockImplementationOnce(async (id: number) => {
        strip.setGroup(id, 99)
        return {}
      })

      await tabSortService.sortGroupTabsByHost()

      expect(mockBrowser.tabs.group).toHaveBeenCalledWith({ tabIds: [2], groupId: 10 })
      expect(strip.groupOf(2)).toBe(10)
    })

    it("should handle errors gracefully without throwing", async () => {
      mockBrowser.tabs.query.mockRejectedValue(new Error("API error"))

      await expect(tabSortService.sortGroupTabsByHost()).resolves.toBeUndefined()
    })

    it("should do nothing when window has no id", async () => {
      mockBrowser.windows.getCurrent.mockResolvedValueOnce({ id: undefined })

      await tabSortService.sortGroupTabsByHost()

      expect(mockBrowser.tabs.query).not.toHaveBeenCalled()
    })
  })

  describe("mutex", () => {
    it("should not let two sort operations run concurrently", async () => {
      const order: string[] = []
      let releaseFirst: () => void = () => {}
      const gate = new Promise<void>(resolve => {
        releaseFirst = resolve
      })

      let call = 0
      mockBrowser.windows.getCurrent.mockImplementation(async () => {
        call++
        const thisCall = call
        order.push(`start:${thisCall}`)
        if (thisCall === 1) {
          await gate
        }
        return { id: 1 }
      })
      mockBrowser.tabs.query.mockResolvedValue([])

      // Two different entry points, sharing the same mutex
      const first = tabSortService.sortGroupTabsByContainer()
      const second = tabSortService.sortGroupTabsByHost()

      // While the first call is still blocked on the gate, the second call's
      // windows.getCurrent must not have run yet — it's waiting for the mutex.
      await Promise.resolve()
      await Promise.resolve()
      expect(order).toEqual(["start:1"])

      releaseFirst()
      await Promise.all([first, second])

      expect(order).toEqual(["start:1", "start:2"])
    })
  })

  describe("Firefox compatibility", () => {
    it("should not sort when browser.tabGroups.move is not available", async () => {
      const originalMove = mockBrowser.tabGroups.move
      delete (mockBrowser.tabGroups as Record<string, unknown>).move

      await tabSortService.sortGroups()

      expect(mockBrowser.tabGroups.query).not.toHaveBeenCalled()

      // Restore
      mockBrowser.tabGroups.move = originalMove
    })
  })
})
