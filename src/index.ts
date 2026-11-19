/**
 * TTS — the server half of the plugin.
 *
 * Registers the `tts` RPC domain: it fetches assistant replies from the
 * session, sanitizes them for speech, synthesizes audio with the selected
 * engine (Piper locally by default; the online Edge engine only when the
 * user opts in), and keeps user preferences in plugin storage. The GUI half
 * knows nothing about sessions or the engines.
 */
import { Plugin } from "@opencode/plugin"
import { TtsRpc, type Prefs, type ReplyItem, type SpeakInput, type SpeakResult, type TtsEngine } from "./rpc"
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
import { EDGE_VOICES, rateToProsody, synthesize as synthesizeWithEdge } from "./edge"

const PREFS_KEY = "tts/prefs"
/** Storage key used before the plugin was renamed; preferences migrate on first load. */
const LEGACY_PREFS_KEY = "read-aloud/prefs"
const MAX_REPLIES = 20
const PREVIEW_CHARS = 90

const DEFAULT_PREFS: Prefs = { engine: "piper", voice: "", rate: 0, autoPlay: false, keepWarm: true }

function clampRate(value: unknown): number {
  const rate = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_PREFS.rate
  return Math.max(-50, Math.min(50, Math.round(rate)))
}

function toEngine(value: unknown): TtsEngine | undefined {
  return value === "piper" || value === "edge" ? value : undefined
}

/** What the piper engine is missing, in Japanese, with the exact fix command. */
function engineHint(): string {
  return (
    `Piper が未設定です。インストール: uv tool install piper-tts --with pyopenjtalk-plus; ` +
    `音声モデルは ${defaultVoicesDir()} に .onnx と .onnx.json を配置してください（README 参照）`
  )
}

/** What an online-engine failure looks like to the user, in Japanese. */
function edgeHint(): string {
  return "オンライン音声（Microsoft Edge）の取得に失敗しました。ネットワークを確認するか、設定でローカル音声（Piper）に戻ってください"
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
      const engine = toEngine(stored.engine) ?? DEFAULT_PREFS.engine
      const storedVoice = typeof stored.voice === "string" ? stored.voice : ""
      // Engine-specific voice validation: an online voice has to be one of the
      // curated ids, piper voices are models on disk that speak() resolves
      // against what is installed. A piper voice that still carries an old
      // edge-tts id (ja-JP-*) no longer means anything and resets to default.
      const voice =
        engine === "edge"
          ? EDGE_VOICES.some((candidate) => candidate.id === storedVoice)
            ? storedVoice
            : ""
          : storedVoice && !storedVoice.startsWith("ja-JP-")
            ? storedVoice
            : ""
      return {
        engine,
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
        const utterance = flattenUtterance(clipped)
        if (prefs.engine === "edge") {
          const voice = EDGE_VOICES.some((candidate) => candidate.id === prefs.voice)
            ? prefs.voice
            : EDGE_VOICES[0].id
          try {
            const bytes = await synthesizeWithEdge(utterance, voice, rateToProsody(prefs.rate), {
              signal: control.signal,
            })
            return { audio: toBase64(bytes), mime: "audio/mpeg", truncated, ...(messageID ? { messageID } : {}) }
          } catch (error) {
            if (control.signal.aborted) throw error
            const detail = error instanceof Error ? error.message : String(error)
            throw new Error(`${detail} — ${edgeHint()}`, { cause: error })
          }
        }
        const bin = resolvePiperBin()
        const voice = bin ? await pickVoice(prefs.voice) : undefined
        if (!bin || !voice) throw new Error(engineHint())
        const bytes = await synthesizeWithPiper(bin, voice, rateToLengthScale(prefs.rate), utterance, {
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
        const prefs = await loadPrefs()
        if (prefs.engine === "edge") {
          // Static curated list: honest labels without a network call, with a
          // note so the privacy trade-off is visible where the choice is made.
          return {
            voices: EDGE_VOICES.map(({ id, label }) => ({ id, label })),
            note: "オンライン音声: 読み上げ時にテキストが Microsoft のサービスへ送信されます。",
          }
        }
        const voices = await installedVoices()
        if (voices.length > 0) return { voices: voices.map(({ id, label }) => ({ id, label })) }
        return { voices: [], note: engineHint() }
      },
      prefs: async () => await loadPrefs(),
      setPrefs: async (raw) => {
        const input = (raw ?? {}) as Partial<Prefs>
        const current = await loadPrefs()
        const engine = toEngine(input.engine) ?? current.engine
        // Voices are engine-specific: switching engines drops the old pick.
        const switched = engine !== current.engine
        let voice = input.voice === undefined ? (switched ? "" : current.voice) : input.voice
        if (engine === "edge" && voice && !EDGE_VOICES.some((candidate) => candidate.id === voice)) voice = ""
        const rate = input.rate === undefined ? current.rate : clampRate(input.rate)
        const autoPlay = input.autoPlay === undefined ? current.autoPlay : input.autoPlay === true
        const keepWarm = typeof input.keepWarm === "boolean" ? input.keepWarm : current.keepWarm
        const next: Prefs = { engine, voice, rate, autoPlay, keepWarm }
        await ctx.storage.set(PREFS_KEY, { ...next })
        return next
      },
    })
  },
})
