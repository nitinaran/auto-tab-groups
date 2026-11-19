import { describe, expect, it } from "vitest"
import { DEFAULT_STATE } from "../types/storage"
import { formatHostKeyRules, getHostKey, parseHostKeyRules } from "../utils/HostKeyUtils"

describe("HostKeyUtils", () => {
  describe("parseHostKeyRules", () => {
    it("should parse pattern => label lines", () => {
      expect(parseHostKeyRules("a.com/wiki => Wiki\nb.com => B")).toEqual([
        { pattern: "a.com/wiki", label: "Wiki" },
        { pattern: "b.com", label: "B" }
      ])
    })

    it("should default the label to the pattern", () => {
      expect(parseHostKeyRules("a.com/wiki")).toEqual([
        { pattern: "a.com/wiki", label: "a.com/wiki" }
      ])
      expect(parseHostKeyRules("a.com/wiki =>")).toEqual([
        { pattern: "a.com/wiki", label: "a.com/wiki" }
      ])
    })

    it("should skip blank lines, comments, and lines with no pattern", () => {
      expect(parseHostKeyRules("\n# note\n  \n=> Orphan\r\na.com => A\r\n")).toEqual([
        { pattern: "a.com", label: "A" }
      ])
    })

    it("should trim whitespace around pattern and label", () => {
      expect(parseHostKeyRules("   a.com   =>    A   ")).toEqual([{ pattern: "a.com", label: "A" }])
    })

    it("should round-trip through formatHostKeyRules", () => {
      const text = "a.com/wiki => Wiki\nb.com"
      expect(formatHostKeyRules(parseHostKeyRules(text))).toBe(text)
    })
  })

  describe("getHostKey", () => {
    const rules = DEFAULT_STATE.hostKeyRules

    it("should return the hostname when no rule matches", () => {
      expect(getHostKey("https://github.com/org/repo", rules)).toBe("github.com")
    })

    it("should return an empty string for missing or unparsable URLs", () => {
      expect(getHostKey(undefined, rules)).toBe("")
      expect(getHostKey("not a url", rules)).toBe("")
    })

    it("should key /wiki on Atlassian Cloud as Confluence (default rules)", () => {
      expect(getHostKey("https://viavi.atlassian.net/wiki", rules)).toBe("Confluence")
      expect(getHostKey("https://viavi.atlassian.net/wiki/spaces/ENG/overview", rules)).toBe(
        "Confluence"
      )
    })

    it("should key other Atlassian Cloud paths as Jira (default rules)", () => {
      expect(getHostKey("https://viavi.atlassian.net/jira", rules)).toBe("Jira")
      expect(getHostKey("https://viavi.atlassian.net/browse/ABC-1", rules)).toBe("Jira")
      expect(getHostKey("https://viavi.atlassian.net/", rules)).toBe("Jira")
    })

    it("should not apply the Atlassian defaults to other hosts", () => {
      expect(getHostKey("https://example.com/wiki/page", rules)).toBe("example.com")
      expect(getHostKey("https://atlassian.com/wiki", rules)).toBe("atlassian.com")
    })

    it("should let the first matching rule win", () => {
      const ordered = parseHostKeyRules("a.com/x => First\na.com => Second")
      expect(getHostKey("https://a.com/x/1", ordered)).toBe("First")
      expect(getHostKey("https://a.com/y", ordered)).toBe("Second")
    })

    it("should return the hostname when the rule list is empty", () => {
      expect(getHostKey("https://viavi.atlassian.net/wiki", [])).toBe("viavi.atlassian.net")
    })

    it("should ignore a rule whose pattern is invalid instead of throwing", () => {
      const bad = parseHostKeyRules("{unclosed => Bad\n/[/ => AlsoBad")
      expect(getHostKey("https://a.com/x", bad)).toBe("a.com")
    })
  })
})
