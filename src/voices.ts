/**
 * Voice identity across engines.
 *
 * One preference string selects everything: which engine, which model, which
 * speaker inside a multi-speaker model, and whether the child formant effect
 * is applied. The grammar is compact and storable:
 *
 *   piper:<model stem>#<speaker>[!child]   local Piper voice
 *   edge:<ShortName>                       online Edge voice
 *   voicevox:<speakerId>                   local VOICEVOX engine
 *
 * Catalog assembly (what the picker lists) is pure here so the grouping and
 * labelling are testable without spawning anything.
 */
import { basename } from "node:path"
import type { PiperVoice } from "./tts"

/** Voice offered to the GUI; `id` doubles as the stored preference. */
export interface VoiceItem {
  id: string
  label: string
  engine: "piper" | "voicevox" | "edge"
  online: boolean
  gender: "male" | "female" | "unknown"
  /** Child voice (real child speaker or pitch effect). */
  child: boolean
  /** Pitch-shift effect rather than a real child voice. */
  fx?: boolean
  /** Model file name (without extension) for piper ids. */
  stem?: string
  /** Absolute `.onnx` path for piper ids. */
  model?: string
  /** Speaker index inside the piper model. */
  speaker?: number
  /** VOICEVOX speaker id. */
  speakerId?: number
}

/** What a parsed voice id asks the server to do. */
export type ResolvedVoice =
  | { kind: "piper"; model: string; speaker?: number; child: boolean }
  | { kind: "edge"; shortName: string }
  | { kind: "voicevox"; speakerId: number }

/** A VOICEVOX speaker as reported by the engine. */
export interface VoicevoxSpeaker {
  id: number
  name: string
  isMale?: boolean
  isChild?: boolean
}

/**
 * Parse a voice id against the current catalog (piper ids resolve through it,
 * so stale model names simply stop resolving instead of hitting the disk).
 * Anything malformed or unknown returns null and the caller falls back.
 */
export function parseVoiceId(id: string, catalog: VoiceItem[] = []): ResolvedVoice | null {
  const raw = id.trim()
  if (!raw) return null
  if (raw.startsWith("piper:")) {
    const body = raw.slice("piper:".length)
    const child = body.endsWith("!child")
    const core = child ? body.slice(0, -"!child".length) : body
    const match = /^(.+)#(\d+)$/.exec(core)
    const stem = match ? match[1] : core
    const speaker = match ? Number(match[2]) : undefined
    if (!stem) return null
    const item = catalog.find(
      (voice) => voice.engine === "piper" && voice.stem === stem && (speaker === undefined || voice.speaker === speaker),
    )
    if (!item?.model) return null
    return { kind: "piper", model: item.model, speaker: item.speaker, child }
  }
  if (raw.startsWith("edge:")) {
    const shortName = raw.slice("edge:".length).trim()
    return shortName ? { kind: "edge", shortName } : null
  }
  if (raw.startsWith("voicevox:")) {
    const speakerId = Number(raw.slice("voicevox:".length))
    return Number.isInteger(speakerId) && speakerId >= 0 ? { kind: "voicevox", speakerId } : null
  }
  return null
}

/** Voice id used when the stored preference is missing or unknown. */
export function defaultVoiceId(catalog: VoiceItem[]): string {
  const local = catalog.filter((voice) => !voice.online && !voice.child)
  const female = local.find((voice) => voice.gender === "female")
  return (female ?? local[0] ?? catalog[0])?.id ?? ""
}

/** Pretty engine-independent display name for a Piper model stem. */
export function piperDisplayName(stem: string): string {
  return stem.replace(/^ja_JP-/, "").replace(/-(medium|high|x_low|x_high)$/, "")
}

/** Gender hint from a scanned Piper voice (`女性（…）` labels start the list). */
function piperGender(voice: PiperVoice): "male" | "female" | "unknown" {
  if (voice.label.startsWith("男性")) return "male"
  if (voice.label.startsWith("女性")) return "female"
  if (/female/i.test(voice.label)) return "female" // before male: "female" contains "male"
  if (/male/i.test(voice.label)) return "male"
  return "unknown"
}

/**
 * The picker contents: local Piper first, then VOICEVOX when its engine is
 * running, online Edge last. `fxChild` adds pitch-shift child variants for
 * every adult local voice.
 */
export function buildCatalog(input: {
  piper: PiperVoice[]
  voicevox?: VoicevoxSpeaker[]
  edge?: readonly { id: string; label: string }[]
  fxChild?: boolean
}): VoiceItem[] {
  const items: VoiceItem[] = []
  for (const voice of input.piper) {
    const stem = basename(voice.model).replace(/\.onnx$/, "")
    const label = piperDisplayName(stem)
    const gender = piperGender(voice)
    const adult: VoiceItem = {
      id: `piper:${stem}#${voice.speaker}`,
      label,
      engine: "piper",
      online: false,
      gender,
      child: false,
      stem,
      model: voice.model,
      speaker: voice.speaker,
    }
    items.push(adult)
    if (input.fxChild) {
      items.push({ ...adult, id: `${adult.id}!child`, child: true, fx: true, label: `${label}（子供）` })
    }
  }

  for (const speaker of input.voicevox ?? []) {
    items.push({
      id: `voicevox:${speaker.id}`,
      label: speaker.name,
      engine: "voicevox",
      online: false,
      gender: speaker.isMale === undefined ? "unknown" : speaker.isMale ? "male" : "female",
      child: speaker.isChild ?? false,
      speakerId: speaker.id,
    })
  }

  for (const voice of input.edge ?? []) {
    items.push({
      id: `edge:${voice.id}`,
      label: voice.id.replace(/^ja-JP-/, "").replace(/Neural$/, ""),
      engine: "edge",
      online: true,
      gender: /male(?!.*female)/i.test(voice.label) && !/female/i.test(voice.label) ? "male" : "female",
      child: false,
    })
  }
  return items
}

/** Groups for the picker, in display order. */
export function catalogGroups(catalog: VoiceItem[]): { title: string; voices: VoiceItem[] }[] {
  const local = catalog.filter((voice) => !voice.online)
  const online = catalog.filter((voice) => voice.online)
  const groups: { title: string; voices: VoiceItem[] }[] = []
  if (local.length) groups.push({ title: "ローカル", voices: local })
  if (online.length) groups.push({ title: "オンライン", voices: online })
  return groups
}

/** Short tags shown on a picker row (男性 / 女性 / 子供 / 子供風). */
export function voiceTags(voice: VoiceItem): string[] {
  const tags: string[] = []
  if (voice.gender === "male") tags.push("男性")
  if (voice.gender === "female") tags.push("女性")
  if (voice.child) tags.push(voice.fx ? "子供風" : "子供")
  return tags
}

/** The playback speed a child voice is played back at (also the pitch gain). */
export const CHILD_PLAYBACK_RATE = 1.21

/** Length scale that compensates child playback so speech keeps its pace. */
export function childLengthScale(ratePercent: number, base: (rate: number) => number): number {
  return base(ratePercent) * CHILD_PLAYBACK_RATE
}
