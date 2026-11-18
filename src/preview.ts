/**
 * Finding the file the user is looking at.
 *
 * The host gives plugins no "current file" accessor, but its own stylesheet
 * documents the tab strip of the review panel: every tab trigger wrapper carries
 * `data-value`, and the file tabs are keyed `file://` plus the workspace-relative
 * path with its segments percent-encoded (`file://docs/notes%20board.md`). The
 * selected trigger carries `data-selected` and `aria-selected`, so the pair
 * tells us which file the panel shows.
 */

/** Prefix of the host's file tab keys. */
const FILE_TAB_PREFIX = "file://"

/** The host's review panel: the side panel that shows file contents. */
const PANEL_SELECTOR = "#review-panel"

/** Tab triggers inside a tab strip; the wrapper around them holds `data-value`. */
const TAB_TRIGGER_SELECTOR = '[role="tab"]'

/** One tab of a strip, read out of the DOM. */
export interface TabCandidate {
  /** The tab key from `data-value` (`file://docs/a.md`, `browser:tab_1`, …). */
  readonly value: string
  /** Whether the user has that tab in front of them. */
  readonly selected: boolean
}

/** Decodes the percent-encoding of each path segment, leaving `/` alone. */
function decodeTabPath(value: string): string {
  return value
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join("/")
}

/**
 * The path a file tab key stands for, or undefined when the key is not a
 * workspace file (browser tabs, the file picker's `file:open` tab).
 *
 * @param value - A tab's `data-value`.
 */
export function pathFromTabKey(value: string | null | undefined): string | undefined {
  if (!value || !value.startsWith(FILE_TAB_PREFIX)) return undefined
  const rest = value.slice(FILE_TAB_PREFIX.length)
  if (!rest) return undefined
  const decoded = decodeTabPath(rest)
  // `file:///etc/hosts` is a file outside the workspace and stays absolute.
  const path = decoded.startsWith("/") ? decoded : decoded.replace(/^\/+/, "")
  return path.trim() ? path : undefined
}

/**
 * The first selected file tab, in DOM order.
 *
 * @param candidates - Tabs of one strip, newest view of the panel.
 */
export function pickPreviewedFile(candidates: readonly TabCandidate[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate.selected) continue
    const path = pathFromTabKey(candidate.value)
    if (path) return path
  }
  return undefined
}

/** Reads the tabs of every strip inside `root`, in document order. */
export function previewTabCandidates(root: ParentNode): TabCandidate[] {
  const found: TabCandidate[] = []
  for (const node of Array.from(root.querySelectorAll(TAB_TRIGGER_SELECTOR))) {
    const trigger = node as Element
    const holder = trigger.closest("[data-value]") ?? trigger
    const value = holder.getAttribute("data-value") ?? trigger.getAttribute("data-value")
    if (!value) continue
    found.push({
      value,
      selected: trigger.hasAttribute("data-selected") || trigger.getAttribute("aria-selected") === "true",
    })
  }
  return found
}

/**
 * The workspace path of the file the review panel shows, or undefined when the
 * panel holds no file tab (a browser tab, the changes view, or nothing open).
 */
export function previewedFilePath(): string | undefined {
  if (typeof document === "undefined") return undefined
  const panel = document.querySelector(PANEL_SELECTOR)
  return pickPreviewedFile(previewTabCandidates(panel ?? document))
}

/** The name to show for a path: its last segment. */
export function fileLabel(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}
