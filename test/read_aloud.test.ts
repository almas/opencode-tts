import { describe, expect, test } from "vitest"
import {
  buttonStateFor,
  claimMenu,
  pickMessageText,
  requiredLeadSec,
  triggerInsidePanel,
  MESSAGE_TEXT_SELECTOR,
  type NodeLike,
  type ScopeLike,
} from "../src/read_aloud"

describe("buttonStateFor", () => {
  test("shows playing when this message's audio plays", () => {
    expect(buttonStateFor("m1", "m1", "")).toBe("playing")
  })

  test("shows busy while this message's audio is fetched", () => {
    expect(buttonStateFor("m1", "", "m1")).toBe("busy")
  })

  test("stays idle for other messages' play states", () => {
    expect(buttonStateFor("m1", "m2", "")).toBe("idle")
    expect(buttonStateFor("m1", "", "m2")).toBe("idle")
  })

  test("playing wins over busy for the same id", () => {
    expect(buttonStateFor("m1", "m1", "m1")).toBe("playing")
  })

  test("an unknown playing or busy id leaves every button idle", () => {
    expect(buttonStateFor("", "", "")).toBe("idle")
    expect(buttonStateFor("m1", undefined, undefined)).toBe("idle")
  })
})

describe("pickMessageText", () => {
  const body = (text: string): NodeLike => ({ textContent: text })
  const scope = (bodies: NodeLike[], own?: string): ScopeLike => ({
    querySelectorAll: (selector) => (selector === MESSAGE_TEXT_SELECTOR ? bodies : []),
    textContent: own ?? bodies.map((b) => b.textContent ?? "").join(""),
  })

  test("joins the text parts with blank lines", () => {
    expect(pickMessageText(scope([body("first reply"), body("second reply")]))).toBe("first reply\n\nsecond reply")
  })

  test("skips empty parts", () => {
    expect(pickMessageText(scope([body("  "), body("text"), body(null as unknown as string)]))).toBe("text")
  })

  test("falls back to the scope's own text when no part is marked", () => {
    expect(pickMessageText(scope([], "  whole message  "))).toBe("whole message")
  })

  test("returns empty text for a message with nothing readable", () => {
    expect(pickMessageText(scope([], null))).toBe("")
  })
})

describe("triggerInsidePanel", () => {
  const inside = { closest: (selector: string) => (selector === "#review-panel" ? {} : null) }
  const outside = { closest: () => null }

  test("accepts a target inside the review panel", () => {
    expect(triggerInsidePanel(inside, "#review-panel")).toBe(true)
  })

  test("rejects targets outside the panel and missing targets", () => {
    expect(triggerInsidePanel(outside, "#review-panel")).toBe(false)
    expect(triggerInsidePanel(null, "#review-panel")).toBe(false)
    expect(triggerInsidePanel(undefined, "#review-panel")).toBe(false)
  })

  test("rejects targets without a closest method", () => {
    expect(triggerInsidePanel({}, "#review-panel")).toBe(false)
  })
})

describe("claimMenu", () => {
  const fakeMenu = () => {
    const attrs = new Map<string, string>()
    return {
      getAttribute: (name: string) => attrs.get(name) ?? null,
      setAttribute: (name: string, value: string) => void attrs.set(name, value),
    }
  }

  test("claims an untouched menu exactly once", () => {
    const menu = fakeMenu()
    expect(claimMenu(menu, "marker")).toBe(true)
    expect(claimMenu(menu, "marker")).toBe(false)
  })

  test("claims different menus independently", () => {
    expect(claimMenu(fakeMenu(), "marker")).toBe(true)
    expect(claimMenu(fakeMenu(), "marker")).toBe(true)
  })
})

describe("requiredLeadSec", () => {
  test("unmeasured rate keeps the plain first-segment lead", () => {
    expect(requiredLeadSec(0)).toBe(0.4)
    expect(requiredLeadSec(Number.NaN)).toBe(0.4)
  })

  test("a warm engine outrunning playback starts quickly", () => {
    expect(requiredLeadSec(2)).toBe(0.45)
    expect(requiredLeadSec(40)).toBe(0.45)
  })

  test("a barely-ahead engine buffers more before starting", () => {
    expect(requiredLeadSec(1.5)).toBe(1.0)
    expect(requiredLeadSec(1.0)).toBe(2.0)
    expect(requiredLeadSec(0.5)).toBe(2.0)
  })

  test("the lead shrinks as the engine warms up", () => {
    expect(requiredLeadSec(0.5)).toBeGreaterThan(requiredLeadSec(1.5))
    expect(requiredLeadSec(1.5)).toBeGreaterThan(requiredLeadSec(3))
  })
})
