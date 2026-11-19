/**
 * TTS — the server half of the plugin.
 *
 * Registers the `tts` RPC domain: it fetches assistant replies from
 * the session, sanitizes them for speech, synthesizes MP3 with the
 * edge-tts service, and keeps user preferences in plugin storage. The GUI
 * half knows nothing about sessions or the speech service.
 */
import { Plugin } from "@opencode/plugin"
import { TtsRpc, type Prefs, type ReplyItem, type SpeakInput, type SpeakResult } from "./rpc"
import { MAX_SPEECH_CHARACTERS, sanitizeForSpeech, synthesize } from "./tts"

const PREFS_KEY = "tts/prefs"
/** Storage key used before the plugin was renamed; preferences migrate on first load. */
const LEGACY_PREFS_KEY = "read-aloud/prefs"
const MAX_REPLIES = 20
const PREVIEW_CHARS = 90

const VOICES = [
  { id: "ja-JP-NanamiNeural", label: "Nanami（女性・標準）" },
  { id: "ja-JP-KeitaNeural", label: "Keita（男性・標準）" },
  { id: "ja-JP-AoiNeural", label: "Aoi（女性）" },
  { id: "ja-JP-DaichiNeural", label: "Daichi（男性）" },
  { id: "ja-JP-MayuNeural", label: "Mayu（女性）" },
  { id: "ja-JP-NaokiNeural", label: "Naoki（男性）" },
  { id: "ja-JP-ShioriNeural", label: "Shiori（女性）" },
] as const

const DEFAULT_PREFS: Prefs = { voice: "ja-JP-NanamiNeural", rate: 0, autoPlay: false, keepWarm: true }

function clampRate(value: unknown): number {
  const rate = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_PREFS.rate
  return Math.max(-50, Math.min(50, Math.round(rate)))
}

function rateText(rate: number): string {
  return rate >= 0 ? `+${rate}%` : `${rate}%`
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")
  }
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS)}…` : oneLine
}

export default Plugin.define({
  id: "tts",
  async setup(ctx) {
    const normalizePrefs = (stored: Partial<Prefs> | undefined): Prefs => {
      if (!stored || typeof stored !== "object") return { ...DEFAULT_PREFS }
      const voice = VOICES.some((voice) => voice.id === stored.voice) ? stored.voice! : DEFAULT_PREFS.voice
      return {
        voice,
        rate: clampRate(stored.rate),
        autoPlay: stored.autoPlay === true,
        keepWarm: typeof stored.keepWarm === "boolean" ? stored.keepWarm : DEFAULT_PREFS.keepWarm,
      }
    }

    const loadPrefs = async (): Promise<Prefs> => {
      try {
        let stored = (await ctx.storage.get(PREFS_KEY)) as Partial<Prefs> | undefined
        if (!stored || typeof stored !== "object") {
          const legacy = (await ctx.storage.get(LEGACY_PREFS_KEY)) as Partial<Prefs> | undefined
          if (legacy && typeof legacy === "object") {
            stored = legacy
            await ctx.storage.set(PREFS_KEY, { ...normalizePrefs(legacy) })
          }
        }
        return normalizePrefs(stored)
      } catch {
        return { ...DEFAULT_PREFS }
      }
    }

    const fetchReplies = async (sessionID: string): Promise<ReplyItem[]> => {
      if (!sessionID) return []
      const messages = await ctx.session.context({ sessionID })
      const replies: ReplyItem[] = []
      for (const message of messages) {
        if (message.type !== "assistant") continue
        const text = sanitizeForSpeech(
          message.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n\n"),
        )
        if (!text) continue
        replies.push({ id: String(message.id), text, preview: preview(text) })
      }
      return replies.slice(-MAX_REPLIES)
    }

    await ctx.rpc.register(TtsRpc, {
      speak: async (raw, control): Promise<SpeakResult> => {
        const input = (raw ?? {}) as SpeakInput
        const prefs = await loadPrefs()
        let rawText = input.text ?? ""
        let messageID: string | undefined
        if (!rawText.trim() && input.sessionID) {
          const replies = await fetchReplies(input.sessionID)
          const wanted = input.messageID ? replies.find((reply) => reply.id === input.messageID) : replies.at(-1)
          rawText = wanted?.text ?? ""
          messageID = wanted?.id
        }
        const text = sanitizeForSpeech(rawText)
        if (!text) return { audio: "", mime: "audio/mpeg", truncated: false, ...(messageID ? { messageID } : {}) }
        const truncated = text.length > MAX_SPEECH_CHARACTERS
        const clipped = truncated ? text.slice(0, MAX_SPEECH_CHARACTERS) : text
        const bytes = await synthesize(clipped, prefs.voice, rateText(prefs.rate), { signal: control.signal })
        return { audio: toBase64(bytes), mime: "audio/mpeg", truncated, ...(messageID ? { messageID } : {}) }
      },
      replies: async (raw) => {
        const sessionID = String((raw as { sessionID?: unknown } | undefined)?.sessionID ?? "")
        return { replies: await fetchReplies(sessionID) }
      },
      latest: async (raw) => {
        const sessionID = String((raw as { sessionID?: unknown } | undefined)?.sessionID ?? "")
        const replies = await fetchReplies(sessionID)
        const latest = replies.at(-1)
        return latest ? { reply: latest } : {}
      },
      voices: async () => ({ voices: [...VOICES] }),
      prefs: async () => await loadPrefs(),
      setPrefs: async (raw) => {
        const input = (raw ?? {}) as Partial<Prefs>
        const current = await loadPrefs()
        const voice =
          typeof input.voice === "string" && VOICES.some((voice) => voice.id === input.voice)
            ? input.voice
            : current.voice
        const rate = input.rate === undefined ? current.rate : clampRate(input.rate)
        const autoPlay = input.autoPlay === undefined ? current.autoPlay : input.autoPlay === true
        const keepWarm = typeof input.keepWarm === "boolean" ? input.keepWarm : current.keepWarm
        const next: Prefs = { voice, rate, autoPlay, keepWarm }
        await ctx.storage.set(PREFS_KEY, { ...next })
        return next
      },
    })
  },
})
