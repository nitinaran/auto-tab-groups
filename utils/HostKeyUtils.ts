/**
 * Helpers for the same-host sort's key rules: parsing the editable text form,
 * and resolving which key a tab's URL sorts under.
 */

import type { HostKeyRule } from "../types"
import { urlPatternMatcher } from "./UrlPatternMatcher"

const RULE_SEPARATOR = "=>"
const COMMENT_PREFIX = "#"

/**
 * Parses the editable text form into rules. One rule per line as
 * "pattern => label"; the label defaults to the pattern when omitted. Blank
 * lines and lines starting with "#" are ignored.
 */
export function parseHostKeyRules(text: string): HostKeyRule[] {
  const rules: HostKeyRule[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(COMMENT_PREFIX)) continue

    const separatorIndex = line.indexOf(RULE_SEPARATOR)
    const pattern = (separatorIndex === -1 ? line : line.slice(0, separatorIndex)).trim()
    if (!pattern) continue

    const label = separatorIndex === -1 ? "" : line.slice(separatorIndex + RULE_SEPARATOR.length)
    rules.push({ pattern, label: label.trim() || pattern })
  }

  return rules
}

/**
 * Inverse of parseHostKeyRules, for showing the rules in the settings editor.
 */
export function formatHostKeyRules(rules: HostKeyRule[]): string {
  return rules
    .map(rule =>
      rule.label === rule.pattern ? rule.pattern : `${rule.pattern} ${RULE_SEPARATOR} ${rule.label}`
    )
    .join("\n")
}

/**
 * Returns the key a tab's URL sorts under: the label of the first rule whose
 * pattern matches, otherwise the URL's hostname. Returns "" for a missing or
 * unparsable URL (e.g. internal pages some browsers restrict access to).
 */
export function getHostKey(url: string | undefined, rules: HostKeyRule[]): string {
  if (!url) return ""

  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return ""
  }

  for (const rule of rules) {
    if (urlPatternMatcher.match(url, rule.pattern).matched) return rule.label
  }
  return hostname
}
