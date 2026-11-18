/**
 * Read-aloud controls placed where the user already looks.
 *
 * The SDK exposes no registry for message actions or review-panel menus, so the
 * plugin watches the host DOM (see gui.tsx) and injects into two anchors the
 * stylesheet documents:
 *
 * - `div[data-slot="text-part-copy-wrapper"]`, the hover toolbar under an
 *   assistant reply that already holds the copy button; the injected button is
 *   appended as its last child so it inherits the wrapper's hover behaviour.
 * - Kobalte's `role="menu"` popovers opened from inside `#review-panel` (the
 *   tab right-click menu and the strip's kebab menu), where the item is cloned
 *   from an existing `[role="menuitem"]` so it matches the host's item styling.
 */

/** Attribute marking the injected per-message button. */
export const READ_BUTTON_ATTR = "data-oc-tts-read"

/** Attribute marking the injected menu item. */
export const READ_MENU_ATTR = "data-oc-tts-read-menu"

/** Host hover toolbar that holds the copy button under a text part. */
export const COPY_WRAPPER_SELECTOR = '[data-slot="text-part-copy-wrapper"]'

/** Selector for the message text itself inside a message scope. */
export const MESSAGE_TEXT_SELECTOR = '[data-slot="text-part-body"]'

/** Play state one injected button should show. */
export type ButtonState = "idle" | "playing" | "busy"

/**
 * Which state a button for `ownId` shows given what is playing or busy.
 *
 * @param ownId - The message id the button belongs to.
 * @param playingId - The id currently being spoken, if any.
 * @param busyId - The id whose audio is being fetched, if any.
 */
export function buttonStateFor(ownId: string, playingId?: string, busyId?: string): ButtonState {
  if (ownId && playingId && playingId === ownId) return "playing"
  if (ownId && busyId && busyId === ownId) return "busy"
  return "idle"
}

/** Minimal node shape the text picker reads (testable without a DOM). */
export interface NodeLike {
  readonly textContent?: string | null
}

/** Minimal scope shape: query for text parts, fall back to its own text. */
export interface ScopeLike {
  querySelectorAll(selector: string): ArrayLike<NodeLike>
  readonly textContent?: string | null
}

/**
 * The speech source for one message: every rendered text part body, joined by
 * blank lines; when no part is marked (older markup), the scope's own text.
 * Code blocks and file chips live inside the body and contribute their text.
 *
 * @param scope - The message element the button belongs to.
 */
export function pickMessageText(scope: ScopeLike): string {
  const bodies: string[] = []
  for (const node of Array.from(scope.querySelectorAll(MESSAGE_TEXT_SELECTOR))) {
    const text = (node.textContent ?? "").trim()
    if (text) bodies.push(text)
  }
  if (bodies.length > 0) return bodies.join("\n\n")
  return (scope.textContent ?? "").trim()
}

/** Minimal event-target shape for the panel test (testable without a DOM). */
export interface TargetLike {
  closest?(selector: string): unknown
}

/**
 * Whether a menu was triggered from inside the review panel, judged from the
 * remembered pointerdown/contextmenu target.
 *
 * @param target - The element that received the triggering event.
 * @param panelSelector - The panel's selector (`#review-panel`).
 */
export function triggerInsidePanel(target: TargetLike | null | undefined, panelSelector: string): boolean {
  if (!target || typeof target.closest !== "function") return false
  return target.closest(panelSelector) != null
}

/** Whether a menu element already carries an injected item (and its marker). */
export interface MenuLike {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
}

/**
 * Guard against double-injecting into one menu element. Reads the marker, and
 * sets it when absent, so the caller only injects on the first call.
 *
 * @param menu - The menu element about to receive an item.
 * @param marker - The marker attribute name (`READ_MENU_ATTR + "-host"`).
 */
export function claimMenu(menu: MenuLike, marker: string): boolean {
  if (menu.getAttribute(marker) != null) return false
  menu.setAttribute(marker, "")
  return true
}
