// @vitest-environment node
import { describe, expect, it } from "vitest"
import { MAX_SPEECH_CHARACTERS, escapeXml, sanitizeForSpeech, splitBytes, ssml } from "../src/tts"

const bytes = (s: string) => new TextEncoder().encode(s).length

describe("escapeXml", () => {
  it("neutralises markup so reply text can never close the SSML envelope", () => {
    const evil = `</prosody></voice></speak><voice name="x"><prosody>&"'<script>alert(1)</script>`
    const out = escapeXml(evil)
    expect(out).not.toContain("<")
    expect(out).not.toContain(">")
    expect(out).not.toContain('"')
    expect(out).not.toContain("'")
  })

  it("escapes ampersands first: literal entities stay literal", () => {
    expect(escapeXml("&lt;")).toBe("&amp;lt;")
    expect(escapeXml("A & B")).toBe("A &amp; B")
  })

  it("leaves plain Japanese untouched", () => {
    expect(escapeXml("こんにちは、父上")).toBe("こんにちは、父上")
  })
})

describe("sanitizeForSpeech", () => {
  it("skips code and keeps prose", () => {
    const out = sanitizeForSpeech("実行します。\n```ts\nconst x = 1\n```\n完了です。`npm test` が通りました。")
    expect(out).toContain("実行します。")
    expect(out).toContain("完了です。")
    expect(out).not.toContain("const x")
    expect(out).not.toContain("npm test")
  })

  it("keeps link words but drops targets, urls, tags and heading marks", () => {
    const out = sanitizeForSpeech("# 報告\n[GitHub](https://github.com/almas) です。 https://example.com/x <b>太字</b>")
    expect(out).toContain("GitHub")
    expect(out).toContain("です。")
    expect(out).not.toContain("https://")
    expect(out).not.toContain("<b>")
    expect(out).not.toMatch(/^#/)
  })

  it("caps length and prefers a sentence boundary", () => {
    const sentence = "これは長い説明の文です。".repeat(2000)
    const out = sanitizeForSpeech(sentence)
    expect(out.length).toBeLessThanOrEqual(MAX_SPEECH_CHARACTERS)
    expect(out.endsWith("。")).toBe(true)
  })

  it("survives empty and whitespace-only input", () => {
    expect(sanitizeForSpeech("")).toBe("")
    expect(sanitizeForSpeech("   \n\n  \t ")).toBe("")
  })
})

describe("splitBytes", () => {
  it("returns one chunk when it already fits", () => {
    expect(splitBytes(" 短い ", 100)).toEqual([" 短い "])
    expect(splitBytes("こんにちは", 4096)).toEqual(["こんにちは"])
  })

  it("never exceeds the frame size and never splits a multi-byte character", () => {
    const text = "日本語のテキストと English words. ".repeat(100)
    for (const chunk of splitBytes(text, 200)) {
      expect(bytes(chunk)).toBeLessThanOrEqual(200)
      // A chunk cut mid-character would round-trip through replacement chars.
      expect(chunk).toBe(new TextDecoder().decode(new TextEncoder().encode(chunk)))
      expect(chunk).not.toContain("\uFFFD")
    }
    expect(splitBytes(text, 200).join("")).toBe(text)
  })

  it("never cuts inside an XML entity", () => {
    const text = `${"あ".repeat(60)}&quot;${"い".repeat(60)}&amp;${"う".repeat(60)}`
    for (const chunk of splitBytes(escapeXml(text), 64)) {
      expect(chunk).not.toMatch(/&(amp|quot|lt|gt|apos|#\d+)?$/)
      expect(bytes(chunk)).toBeLessThanOrEqual(64)
    }
  })

  it("drops whitespace-only remainder", () => {
    expect(splitBytes("   ", 4096)).toEqual([])
  })
})

describe("ssml", () => {
  it("builds a well-formed ja-JP envelope with the escaped payload inside", () => {
    const out = ssml("ja-JP-NanamiNeural", "+0%", escapeXml("親愛なる父上"))
    expect(out.startsWith("<speak version=\"1.0\"")).toBe(true)
    expect(out.endsWith("</speak>")).toBe(true)
    expect(out).toContain('xml:lang="ja-JP"')
    expect(out).toContain('<voice name="ja-JP-NanamiNeural">')
    expect(out).toContain("親愛なる父上")
    const opens = (out.match(/<[^/!][^>]*>/g) ?? []).length
    const closes = (out.match(/<\/[^>]+>/g) ?? []).length
    expect(opens).toBe(closes)
  })

  it("normalises an empty or zero rate to +0%", () => {
    expect(ssml("v", "", "x")).toContain('rate="+0%"')
    expect(ssml("v", "0%", "x")).toContain('rate="+0%"')
    expect(ssml("v", "+20%", "x")).toContain('rate="+20%"')
  })
})
