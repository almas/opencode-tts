/**
 * TTS — the server half of the plugin.
 *
 * Registers the `tts` RPC domain: it fetches assistant replies from the
 * session, sanitizes them for speech, synthesizes WAV locally with Piper,
 * and keeps user preferences in plugin storage. Nothing leaves this
 * machine. The GUI half knows nothing about sessions or the engine.
 */
import { Plugin } from "@opencode/plugin"
import { TtsRpc, type Prefs, type ReplyItem, type SpeakInput, type SpeakResult } from "./rpc"
import {
  MAX_SPEECH_CHARACTERS,
  defaultVoicesDir,
  flattenUtterance,
  rateToLengthScale,
  resolvePiperBin,
  sanitizeForSpeech,
  scanPiperVoices,
  synthesizeWithPiper,
  type PiperVoice,
} from "./tts"

const PREFS_KEY = "tts/prefs"
/** Storage key used before the plugin was renamed; preferences migrate on first load. */
const LEGACY_PREFS_KEY = "read-aloud/prefs"
const MAX_REPLIES = 20
const PREVIEW_CHARS = 90

const DEFAULT_PREFS: Prefs = { voice: "", rate: 0, autoPlay: false, keepWarm: true }

function clampRate(value: unknown): number {
  const rate = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_PREFS.rate
  return Math.max(-50, Math.min(50, Math.round(rate)))
}

/** What the engine is missing, in Japanese, with the exact fix command. */
function engineHint(): string {
  return (
    `Piper が未設定です。インストール: uv tool install piper-tts --with pyopenjtalk-plus; ` +
    `音声モデルは ${defaultVoicesDir()} に .onnx と .onnx.json を配置してください（README 参照）`
  )
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
      // Voice ids are piper models on disk, so they cannot be validated here;
      // speak() resolves whatever is stored against the installed voices.
      // Old edge-tts ids (ja-JP-*) no longer mean anything and reset to default.
      const voice =
        typeof stored.voice === "string" && stored.voice && !stored.voice.startsWith("ja-JP-")
          ? stored.voice
          : DEFAULT_PREFS.voice
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

    /** Installed piper voices, empty when nothing is usable. */
    const installedVoices = () => scanPiperVoices(defaultVoicesDir())

    /** Pick the voice the user asked for, falling back to the first installed. */
    const pickVoice = async (wanted: string): Promise<PiperVoice | undefined> => {
      const voices = await installedVoices()
      return voices.find((voice) => voice.id === wanted) ?? voices[0]
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
        if (!text) return { audio: "", mime: "audio/wav", truncated: false, ...(messageID ? { messageID } : {}) }
        const truncated = text.length > MAX_SPEECH_CHARACTERS
        const clipped = truncated ? text.slice(0, MAX_SPEECH_CHARACTERS) : text
        const bin = resolvePiperBin()
        const voice = bin ? await pickVoice(prefs.voice) : undefined
        if (!bin || !voice) throw new Error(engineHint())
        const bytes = await synthesizeWithPiper(bin, voice, rateToLengthScale(prefs.rate), flattenUtterance(clipped), {
          signal: control.signal,
        })
        return { audio: toBase64(bytes), mime: "audio/wav", truncated, ...(messageID ? { messageID } : {}) }
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
      voices: async () => {
        const voices = await installedVoices()
        if (voices.length > 0) return { voices: voices.map(({ id, label }) => ({ id, label })) }
        return { voices: [], note: engineHint() }
      },
      prefs: async () => await loadPrefs(),
      setPrefs: async (raw) => {
        const input = (raw ?? {}) as Partial<Prefs>
        const current = await loadPrefs()
        const voice =
          typeof input.voice === "string" && input.voice ? input.voice : current.voice
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
