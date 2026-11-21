// @vitest-environment node
import { describe, expect, it } from "vitest"
import { EDGE_VOICES } from "../src/edge"
import {
  buildCatalog,
  catalogGroups,
  CHILD_PLAYBACK_RATE,
  childLengthScale,
  defaultVoiceId,
  parseVoiceId,
  piperDisplayName,
  voiceTags,
  type VoiceItem,
} from "../src/voices"

const MODEL = "/data/ja_JP-hi_fi_captain-medium.onnx"

/** What scanPiperVoices produces for the two-speaker captain model. */
const PIPER = [
  { id: "ja_JP-hi_fi_captain-medium#0", label: "女性（hi_fi_captain）", model: MODEL, speaker: 0 },
  { id: "ja_JP-hi_fi_captain-medium#1", label: "男性（hi_fi_captain）", model: MODEL, speaker: 1 },
]

const catalogOf = (overrides: Partial<Parameters<typeof buildCatalog>[0]> = {}): VoiceItem[] =>
  buildCatalog({ piper: PIPER, edge: EDGE_VOICES, fxChild: true, ...overrides })

describe("parseVoiceId", () => {
  it("resolves piper ids with speaker and child flag through the catalog", () => {
    const catalog = catalogOf()
    expect(parseVoiceId("piper:ja_JP-hi_fi_captain-medium#1!child", catalog)).toEqual({
      kind: "piper",
      model: MODEL,
      speaker: 1,
      child: true,
    })
    expect(parseVoiceId("piper:ja_JP-hi_fi_captain-medium#0", catalog)).toMatchObject({ speaker: 0, child: false })
  })

  it("resolves edge and voicevox ids", () => {
    expect(parseVoiceId("edge:ja-JP-NanamiNeural")).toEqual({ kind: "edge", shortName: "ja-JP-NanamiNeural" })
    expect(parseVoiceId("voicevox:3")).toEqual({ kind: "voicevox", speakerId: 3 })
  })

  it("rejects unknown models and malformed ids instead of hitting the disk", () => {
    expect(parseVoiceId("piper:gone-model#0", [])).toBeNull()
    expect(parseVoiceId("piper:")).toBeNull()
    expect(parseVoiceId("voicevox:x")).toBeNull()
    expect(parseVoiceId("")).toBeNull()
    expect(parseVoiceId("ja-JP-NanamiNeural")).toBeNull() // legacy ids migrate in loadPrefs, not here
  })
})

describe("piperDisplayName", () => {
  it("strips the locale prefix and quality suffix", () => {
    expect(piperDisplayName("ja_JP-hi_fi_captain-medium")).toBe("hi_fi_captain")
  })
})

describe("buildCatalog", () => {
  it("lists adult + child variants per piper speaker, then voicevox, then edge", () => {
    const voices = catalogOf({ voicevox: [{ id: 3, name: "春日談 四朗", isMale: true }] })
    const ids = voices.map((voice) => voice.id)
    expect(ids).toEqual([
      "piper:ja_JP-hi_fi_captain-medium#0",
      "piper:ja_JP-hi_fi_captain-medium#0!child",
      "piper:ja_JP-hi_fi_captain-medium#1",
      "piper:ja_JP-hi_fi_captain-medium#1!child",
      "voicevox:3",
      "edge:ja-JP-NanamiNeural",
      "edge:ja-JP-KeitaNeural",
    ])
  })

  it("reads gender from the speaker labels", () => {
    const byId = new Map(catalogOf().map((voice) => [voice.id, voice]))
    expect(byId.get("piper:ja_JP-hi_fi_captain-medium#0")?.gender).toBe("female")
    expect(byId.get("piper:ja_JP-hi_fi_captain-medium#1")?.gender).toBe("male")
    expect(byId.get("edge:ja-JP-KeitaNeural")?.gender).toBe("male")
    expect(byId.get("edge:ja-JP-NanamiNeural")?.gender).toBe("female")
    expect(byId.get("edge:ja-JP-NanamiNeural")?.online).toBe(true)
  })

  it("marks the pseudo-child flag for the playback-rate trick", () => {
    const child = catalogOf().find((voice) => voice.id.endsWith("!child"))
    expect(child?.child).toBe(true)
    expect(child?.fx).toBe(true)
    expect(child?.label).toContain("子供")
  })
})

describe("defaultVoiceId", () => {
  it("prefers a local female adult voice", () => {
    expect(defaultVoiceId(catalogOf())).toBe("piper:ja_JP-hi_fi_captain-medium#0")
  })

  it("falls back to any local voice, then anything, then empty", () => {
    const maleOnly = catalogOf({ piper: [PIPER[1]], fxChild: false })
    expect(defaultVoiceId(maleOnly)).toBe("piper:ja_JP-hi_fi_captain-medium#1")
    expect(defaultVoiceId(catalogOf({ piper: [], fxChild: false }))).toBe("edge:ja-JP-NanamiNeural")
    expect(defaultVoiceId([])).toBe("")
  })
})

describe("catalogGroups", () => {
  it("splits local from online and skips empty groups", () => {
    const groups = catalogGroups(catalogOf())
    expect(groups.map((group) => group.title)).toEqual(["ローカル", "オンライン"])
    expect(groups[1].voices.map((voice) => voice.id)).toEqual(["edge:ja-JP-NanamiNeural", "edge:ja-JP-KeitaNeural"])
    expect(catalogGroups(catalogOf({ edge: [] })).map((group) => group.title)).toEqual(["ローカル"])
  })
})

describe("voiceTags", () => {
  it("tags rows for the picker", () => {
    const voices = catalogOf()
    expect(voiceTags(voices.find((v) => v.id === "piper:ja_JP-hi_fi_captain-medium#1")!)).toEqual(["男性"])
    expect(voiceTags(voices.find((v) => v.id === "piper:ja_JP-hi_fi_captain-medium#0!child")!)).toEqual([
      "女性",
      "子供風",
    ])
  })
})

describe("child playback", () => {
  it("slows synthesis by exactly the child playback factor", () => {
    const base = (rate: number) => 1 - rate / 200
    expect(childLengthScale(0, base)).toBeCloseTo(1 * CHILD_PLAYBACK_RATE)
    expect(childLengthScale(0, base) / CHILD_PLAYBACK_RATE).toBeCloseTo(1)
  })
})
