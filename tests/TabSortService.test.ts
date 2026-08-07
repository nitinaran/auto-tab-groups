import { beforeEach, describe, expect, it, vi } from "vitest"
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
        .mockResolvedValueOnce({ index: 0 }) // tab 1 queried before first move
        .mockResolvedValueOnce({ index: 1 }) // tab 2 queried before second move

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
  })

  describe("sortGroupTabsByContainer", () => {
    beforeEach(() => {
      tabGroupState.groupByContainer = true
    })

    it("should reorder tabs so same-container tabs are adjacent", async () => {
      // Group 10: tab A (container-2), tab B (container-1) — wrong order
      // Expected: tab B (container-1), tab A (container-2)
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 10, index: 5, cookieStoreId: "firefox-container-2" },
        { id: 2, groupId: 10, index: 6, cookieStoreId: "firefox-container-1" }
      ])
      mockBrowser.tabs.get
        .mockResolvedValueOnce({ index: 6 }) // tab 2 current position before move
        .mockResolvedValueOnce({ index: 6 }) // tab 1 current position after tab 2 moved

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.move).toHaveBeenCalledWith(2, { index: 5 })
    })

    it("should not move tabs already in the correct container order", async () => {
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 10, index: 0, cookieStoreId: "firefox-container-1" },
        { id: 2, groupId: 10, index: 1, cookieStoreId: "firefox-container-2" }
      ])

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should leave a single-tab group untouched", async () => {
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 10, index: 0, cookieStoreId: "firefox-container-1" }
      ])

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should be a no-op on Chrome tabs that have no cookieStoreId", async () => {
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 10, index: 0 },
        { id: 2, groupId: 10, index: 1 },
        { id: 3, groupId: 10, index: 2 }
      ])

      await tabSortService.sortGroupTabsByContainer()

      // All tabs have the same empty container — no reordering needed
      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should process every group in the window when no groupId is given", async () => {
      // Two groups, each with out-of-order containers
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 10, index: 0, cookieStoreId: "firefox-container-2" },
        { id: 2, groupId: 10, index: 1, cookieStoreId: "firefox-container-1" },
        { id: 3, groupId: 20, index: 2, cookieStoreId: "firefox-container-2" },
        { id: 4, groupId: 20, index: 3, cookieStoreId: "firefox-container-1" }
      ])
      mockBrowser.tabs.get
        .mockResolvedValueOnce({ index: 1 })
        .mockResolvedValueOnce({ index: 1 })
        .mockResolvedValueOnce({ index: 3 })
        .mockResolvedValueOnce({ index: 3 })

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.move).toHaveBeenCalledTimes(2)
      expect(mockBrowser.tabs.move).toHaveBeenCalledWith(2, { index: 0 })
      expect(mockBrowser.tabs.move).toHaveBeenCalledWith(4, { index: 2 })
    })

    it("should only sort the specified group when groupId is given", async () => {
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 10, index: 0, cookieStoreId: "firefox-container-2" },
        { id: 2, groupId: 10, index: 1, cookieStoreId: "firefox-container-1" },
        { id: 3, groupId: 20, index: 2, cookieStoreId: "firefox-container-2" },
        { id: 4, groupId: 20, index: 3, cookieStoreId: "firefox-container-1" }
      ])
      mockBrowser.tabs.get
        .mockResolvedValueOnce({ index: 1 })
        .mockResolvedValueOnce({ index: 1 })

      // Only sort group 10
      await tabSortService.sortGroupTabsByContainer(10)

      expect(mockBrowser.tabs.move).toHaveBeenCalledTimes(1)
      expect(mockBrowser.tabs.move).toHaveBeenCalledWith(2, { index: 0 })
    })

    it("should skip ungrouped tabs (groupId === -1)", async () => {
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: -1, index: 0, cookieStoreId: "firefox-container-2" },
        { id: 2, groupId: -1, index: 1, cookieStoreId: "firefox-container-1" }
      ])

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.move).not.toHaveBeenCalled()
    })

    it("should keep tabs with the same container in their original relative order (stable sort)", async () => {
      // Tabs 1 and 3 share container-1; tabs 2 and 4 share container-2
      // After sort: container-1 first (tabs 1, 3), then container-2 (tabs 2, 4)
      mockBrowser.tabs.query.mockResolvedValue([
        { id: 1, groupId: 10, index: 0, cookieStoreId: "firefox-container-1" },
        { id: 2, groupId: 10, index: 1, cookieStoreId: "firefox-container-2" },
        { id: 3, groupId: 10, index: 2, cookieStoreId: "firefox-container-1" },
        { id: 4, groupId: 10, index: 3, cookieStoreId: "firefox-container-2" }
      ])
      // After stable sort: [1(c1), 3(c1), 2(c2), 4(c2)] — needs moves
      mockBrowser.tabs.get
        .mockResolvedValueOnce({ index: 0 }) // tab 1 already at 0, no move
        .mockResolvedValueOnce({ index: 2 }) // tab 3 currently at 2, needs to go to 1
        .mockResolvedValueOnce({ index: 2 }) // tab 2 now at 2 after shift, goes to 2 (no move)
        .mockResolvedValueOnce({ index: 3 }) // tab 4 at 3, goes to 3 (no move)

      await tabSortService.sortGroupTabsByContainer()

      expect(mockBrowser.tabs.move).toHaveBeenCalledWith(3, { index: 1 })
      expect(mockBrowser.tabs.move).toHaveBeenCalledTimes(1)
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
