// @vitest-environment node
import { describe, expect, it } from "vitest"
import { EDGE_VOICES, escapeXml, rateToProsody, splitBytes, ssml } from "../src/edge"

describe("rateToProsody", () => {
  it("signs the percent like SSML wants it", () => {
    expect(rateToProsody(0)).toBe("+0%")
    expect(rateToProsody(10)).toBe("+10%")
    expect(rateToProsody(-20)).toBe("-20%")
  })

  it("clamps nonsense instead of emitting nonsense", () => {
    expect(rateToProsody(-500)).toBe("-90%")
    expect(rateToProsody(500)).toBe("+100%")
    expect(rateToProsody(Number.NaN)).toBe("+0%")
    expect(rateToProsody(3.4)).toBe("+3%")
  })
})

describe("ssml", () => {
  it("wraps the escaped text in a voice element", () => {
    const frame = ssml("ja-JP-NanamiNeural", "+10%", "こんにちは &amp; さようなら")
    expect(frame).toContain('<voice name="ja-JP-NanamiNeural">')
    expect(frame).toContain('rate="+10%"')
    expect(frame).toContain("こんにちは &amp; さようなら")
    expect(frame).toContain('xml:lang="ja-JP"')
  })

  it("normalises a missing rate to +0%", () => {
    expect(ssml("ja-JP-NanamiNeural", "", "x")).toContain('rate="+0%"')
    expect(ssml("ja-JP-NanamiNeural", "0%", "x")).toContain('rate="+0%"')
  })
})

describe("escapeXml / splitBytes", () => {
  it("escapes the five XML entities", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;")
  })

  it("splits long text on byte budget without cutting characters", () => {
    const text = "こんにちは世界".repeat(100)
    const chunks = splitBytes(escapeXml(text), 64)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join("")).toBe(escapeXml(text))
    for (const chunk of chunks) expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(64)
  })

  it("keeps short text in one piece", () => {
    expect(splitBytes("短い文字列", 4096)).toEqual(["短い文字列"])
  })
})

describe("EDGE_VOICES", () => {
  it("lists unique Japanese neural voices with labels", () => {
    const ids = EDGE_VOICES.map((voice) => voice.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const voice of EDGE_VOICES) {
      expect(voice.id.startsWith("ja-JP-")).toBe(true)
      expect(voice.id.endsWith("Neural")).toBe(true)
      expect(voice.label.length).toBeGreaterThan(0)
    }
  })
})
