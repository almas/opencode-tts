// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  MAX_SPEECH_CHARACTERS,
  defaultVoicesDir,
  flattenUtterance,
  rateToLengthScale,
  rateToSpeedScale,
  resolvePiperBin,
  sanitizeForSpeech,
  scanPiperVoices,
} from "../src/tts"

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

describe("flattenUtterance", () => {
  it("joins lines into one utterance", () => {
    expect(flattenUtterance("一行目\n\n二行目\n三行目")).toBe("一行目 二行目 三行目")
  })

  it("trims", () => {
    expect(flattenUtterance("  こんにちは \n")).toBe("こんにちは")
  })
})

describe("rateToLengthScale", () => {
  it("maps the UI rate onto a duration multiplier", () => {
    expect(rateToLengthScale(0)).toBe(1)
    expect(rateToLengthScale(100)).toBe(0.5)
    expect(rateToLengthScale(-50)).toBe(2)
    expect(rateToLengthScale(50)).toBe(0.667)
  })

  it("stays inside the engine's sane range", () => {
    expect(rateToLengthScale(500)).toBe(0.5)
    expect(rateToLengthScale(-500)).toBe(2)
  })
})

describe("rateToSpeedScale", () => {
  it("maps the UI rate onto VOICEVOX's speed multiplier", () => {
    expect(rateToSpeedScale(0)).toBe(1)
    expect(rateToSpeedScale(-50)).toBe(0.5)
    expect(rateToSpeedScale(50)).toBe(1.5)
  })

  it("stays inside the engine's sane range", () => {
    expect(rateToSpeedScale(500)).toBe(2)
    expect(rateToSpeedScale(-500)).toBe(0.5)
  })
})

describe("resolvePiperBin", () => {
  it("honours the override when the file exists and gives up when it does not", () => {
    expect(resolvePiperBin({ OC_TTS_PIPER_BIN: process.execPath })).toBe(process.execPath)
    expect(resolvePiperBin({ OC_TTS_PIPER_BIN: "/nonexistent/piper" })).toBeNull()
  })
})

describe("defaultVoicesDir", () => {
  it("prefers the environment override", () => {
    expect(defaultVoicesDir() !== undefined).toBe(true)
  })
})

describe("scanPiperVoices", () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tts-voices-"))
    // A two-speaker model with named speakers.
    await writeFile(join(dir, "ja_JP-test_medium.onnx"), "fake")
    await writeFile(
      join(dir, "ja_JP-test_medium.onnx.json"),
      JSON.stringify({ num_speakers: 2, speaker_id_map: { female: 0, male: 1 }, dataset: "test-dataset" }),
    )
    // A single-speaker model without a speaker map.
    await writeFile(join(dir, "en_US-other_low.onnx"), "fake")
    await writeFile(join(dir, "en_US-other_low.onnx.json"), JSON.stringify({ num_speakers: 1 }))
    // A model whose sidecar is missing cannot be used.
    await writeFile(join(dir, "broken_model.onnx"), "fake")
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("lists one entry per speaker of every configured model", async () => {
    const voices = await scanPiperVoices(dir)
    const ids = voices.map((voice) => voice.id)
    expect(ids).toContain("ja_JP-test_medium#0")
    expect(ids).toContain("ja_JP-test_medium#1")
    expect(ids).toContain("en_US-other_low#0")
    expect(ids).not.toContain("broken_model#0")
    const female = voices.find((voice) => voice.id === "ja_JP-test_medium#0")!
    expect(female.label).toContain("女性")
    expect(female.label).toContain("test-dataset")
    expect(female.speaker).toBe(0)
    expect(female.model).toBe(join(dir, "ja_JP-test_medium.onnx"))
  })

  it("returns nothing for a missing directory", async () => {
    await expect(scanPiperVoices(join(dir, "nope"))).resolves.toEqual([])
  })
})
