/**
 * TTS — the server half of the plugin.
 *
 * Registers the `tts` RPC domain: it fetches assistant replies from the
 * session, sanitizes them for speech, synthesizes audio with the voice the
 * user picked (local Piper through a resident process, local VOICEVOX when
 * that engine is running, the online Edge engine only when opted in), and
 * keeps preferences in plugin storage. The GUI half knows nothing about
 * sessions or the engines.
 */
import { Plugin } from "@opencode/plugin"
import {
  TtsRpc,
  type AudioInfoResult,
  type CatalogResult,
  type Prefs,
  type ReplyItem,
  type SpeakInput,
  type SpeakResult,
} from "./rpc"
import {
  MAX_SPEECH_CHARACTERS,
  defaultVoicesDir,
  flattenUtterance,
  rateToLengthScale,
  resolvePiperBin,
  sanitizeForSpeech,
  scanPiperVoices,
  synthesizeWithPiper,
} from "./tts"
import { EDGE_VOICES, rateToProsody, synthesize as synthesizeWithEdge } from "./edge"
import {
  audioServer,
  audioServerClientInfo,
  audioServerSynthesize,
  ensureAudioServer,
  resolvePiperPython,
  stopAudioServer,
  type ServerSynthRequest,
} from "./audio_server"
import {
  CHILD_PLAYBACK_RATE,
  buildCatalog,
  childLengthScale,
  defaultVoiceId,
  parseVoiceId,
  type ResolvedVoice,
  type VoiceItem,
} from "./voices"
import { probeVoicevox, synthesizeWithVoicevox } from "./voicevox"

const PREFS_KEY = "tts/prefs"
/** Storage key used before the plugin was renamed; preferences migrate on first load. */
const LEGACY_PREFS_KEY = "read-aloud/prefs"
const MAX_REPLIES = 20
const PREVIEW_CHARS = 90

const DEFAULT_PREFS: Prefs = {
  voice: "",
  rate: 0,
  autoPlay: false,
  keepWarm: true,
  pickVoice: true,
  fastStart: true,
}

function clampRate(value: unknown): number {
  const rate = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_PREFS.rate
  return Math.max(-50, Math.min(50, Math.round(rate)))
}

function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
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
  return "オンライン音声（Microsoft Edge）の取得に失敗しました。ネットワークを確認するか、設定でローカル音声に戻ってください"
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

/** True for ids from the new grammar (namespaced) — anything else is legacy. */
function isNamespacedVoice(voice: string): boolean {
  return voice.startsWith("piper:") || voice.startsWith("edge:") || voice.startsWith("voicevox:")
}

export default Plugin.define({
  id: "tts",
  async setup(ctx) {
    const normalizePrefs = (stored: Partial<Prefs> | undefined): Prefs => {
      if (!stored || typeof stored !== "object") return { ...DEFAULT_PREFS }
      const raw = typeof stored.voice === "string" ? stored.voice.trim() : ""
      // Migration: the old `engine: "edge"` + bare `ja-JP-*` id becomes the
      // namespaced `edge:…`; a bare piper path or `モデル#0` resets and the
      // default voice resolves on first speak.
      let voice = ""
      if (raw) {
        if (isNamespacedVoice(raw)) voice = raw
        else if (/^ja-JP-/.test(raw)) voice = `edge:${raw}`
      }
      return {
        voice,
        rate: clampRate(stored.rate),
        autoPlay: toBool(stored.autoPlay, DEFAULT_PREFS.autoPlay),
        keepWarm: toBool(stored.keepWarm, DEFAULT_PREFS.keepWarm),
        pickVoice: toBool(stored.pickVoice, DEFAULT_PREFS.pickVoice),
        fastStart: toBool(stored.fastStart, DEFAULT_PREFS.fastStart),
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

    /** Everything the picker shows: disk models, optional VOICEVOX, online Edge. */
    const buildVoiceCatalog = async (): Promise<VoiceItem[]> => {
      const [piper, voicevox] = await Promise.all([scanPiperVoices(defaultVoicesDir()), probeVoicevox()])
      return buildCatalog({ piper, voicevox: voicevox ?? undefined, edge: EDGE_VOICES, fxChild: true })
    }

    /** Model files the resident server should hold, for the catalog's piper voices. */
    const serverModels = async (): Promise<string[]> => {
      const catalog = await buildVoiceCatalog()
      const models = new Set<string>()
      for (const voice of catalog) if (voice.engine === "piper" && voice.model) models.add(voice.model)
      return [...models]
    }

    /** Warm the resident engine in the background so the first speak is instant. */
    const warm = async (): Promise<void> => {
      const prefs = await loadPrefs()
      if (!prefs.keepWarm || !prefs.fastStart || !resolvePiperPython()) return
      const models = await serverModels()
      if (models.length) await ensureAudioServer(models)
    }
    void warm().catch(() => {})

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

    /**
     * Piper synthesis with graceful degradation: the resident server when it
     * holds the model (tens of ms), the CLI as fallback (pays the model load
     * every phrase), child voices via length-scale + playback-rate pairing.
     */
    const synthPiper = async (
      resolved: Extract<ResolvedVoice, { kind: "piper" }>,
      utterance: string,
      prefs: Prefs,
      signal: AbortSignal,
    ): Promise<{ audio: string; playbackRate?: number }> => {
      const lengthScale = resolved.child
        ? childLengthScale(prefs.rate, rateToLengthScale)
        : rateToLengthScale(prefs.rate)
      const request: Omit<ServerSynthRequest, "text"> = {
        model: resolved.model,
        speaker: resolved.speaker,
        lengthScale,
      }
      const server = prefs.fastStart ? audioServer() : null
      if (server && server.models.includes(resolved.model)) {
        try {
          const bytes = await audioServerSynthesize(server, { ...request, text: utterance })
          return { audio: toBase64(bytes), ...(resolved.child ? { playbackRate: CHILD_PLAYBACK_RATE } : {}) }
        } catch (error) {
          if (signal.aborted) throw error
          console.warn(`[tts] resident synth failed, using CLI: ${error instanceof Error ? error.message : error}`)
        }
      }
      const bin = resolvePiperBin()
      if (!bin) throw new Error(engineHint())
      const bytes = await synthesizeWithPiper(
        bin,
        { id: "", label: "", model: resolved.model, speaker: resolved.speaker ?? 0 },
        lengthScale,
        utterance,
        { signal },
      )
      return { audio: toBase64(bytes), ...(resolved.child ? { playbackRate: CHILD_PLAYBACK_RATE } : {}) }
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

        const catalog = await buildVoiceCatalog()
        // Resolve wanted → default so a stale stored id still speaks.
        const wantedId = (input.voice ?? "").trim() || prefs.voice
        let useId = wantedId
        let chosen = parseVoiceId(wantedId, catalog) ?? undefined
        if (!chosen) {
          useId = defaultVoiceId(catalog)
          chosen = parseVoiceId(useId, catalog) ?? undefined
        }
        if (!chosen) throw new Error(engineHint())

        const base = { truncated, voice: useId, ...(messageID ? { messageID } : {}) } as const

        if (chosen.kind === "edge") {
          const known = EDGE_VOICES.some((candidate) => candidate.id === chosen!.shortName)
            ? chosen.shortName
            : EDGE_VOICES[0].id
          try {
            const bytes = await synthesizeWithEdge(utterance, known, rateToProsody(prefs.rate), {
              signal: control.signal,
            })
            return { ...base, audio: toBase64(bytes), mime: "audio/mpeg" }
          } catch (error) {
            if (control.signal.aborted) throw error
            const detail = error instanceof Error ? error.message : String(error)
            throw new Error(`${detail} — ${edgeHint()}`, { cause: error })
          }
        }

        if (chosen.kind === "voicevox") {
          try {
            const bytes = await synthesizeWithVoicevox(chosen.speakerId, utterance, undefined, control.signal)
            return { ...base, audio: toBase64(bytes), mime: "audio/wav" }
          } catch (error) {
            if (control.signal.aborted) throw error
            console.warn(`[tts] voicevox synth failed: ${error instanceof Error ? error.message : error}`)
            const piper = catalog.find((voice) => voice.engine === "piper")
            const fallback = piper ? parseVoiceId(piper.id, catalog) : null
            if (!fallback || fallback.kind !== "piper") {
              throw new Error("VOICEVOX で読み上げできませんでした。エンジンが終了した可能性があります", {
                cause: error,
              })
            }
            const audio = await synthPiper(fallback, utterance, prefs, control.signal)
            return { ...base, ...audio, voice: piper!.id, mime: "audio/wav" }
          }
        }

        const audio = await synthPiper(chosen, utterance, prefs, control.signal)
        return { ...base, ...audio, mime: "audio/wav" }
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
      catalog: async (): Promise<CatalogResult> => {
        const voices = await buildVoiceCatalog()
        const note = voices.some((voice) => voice.engine === "piper")
          ? `${engineHint()} ※オンライン音声は「オンライン」の項から選べます`
          : undefined
        return { voices, defaultVoice: defaultVoiceId(voices), ...(note ? { note } : {}) }
      },
      audioInfo: async (raw): Promise<AudioInfoResult> => {
        const input = (raw ?? {}) as { sessionID?: string; messageID?: string; text?: string; voice?: string }
        const prefs = await loadPrefs()
        if (!prefs.fastStart || !resolvePiperPython()) return {}
        const catalog = await buildVoiceCatalog()
        const wantedId = (input.voice ?? "").trim() || prefs.voice || defaultVoiceId(catalog)
        const chosen = parseVoiceId(wantedId, catalog) ?? undefined
        // Fast path only exists for local piper voices; edge/voicevox selections
        // still benefit from nothing here, so the GUI just calls speak.
        if (!chosen || chosen.kind !== "piper") return {}
        let utterance = input.text ?? ""
        if (!utterance.trim() && input.sessionID) {
          const replies = await fetchReplies(input.sessionID)
          utterance = (input.messageID ? replies.find((reply) => reply.id === input.messageID) : replies.at(-1))?.text ?? ""
        }
        utterance = sanitizeForSpeech(utterance)
        const lengthScale = chosen.child
          ? childLengthScale(prefs.rate, rateToLengthScale)
          : rateToLengthScale(prefs.rate)
        try {
          const models = await serverModels()
          const server = await ensureAudioServer(models)
          const info = audioServerClientInfo(server)
          const result: AudioInfoResult = { url: info.url, token: info.token, voice: wantedId }
          if (chosen.child) result.playbackRate = CHILD_PLAYBACK_RATE
          // With a concrete utterance, hand over the full POST body so the webview
          // can stream while the rest of the phrase is still being synthesized.
          if (utterance && server.models.includes(chosen.model)) {
            result.synth = { text: utterance, model: chosen.model, speaker: chosen.speaker ?? 0, lengthScale }
          }
          return result
        } catch {
          return {}
        }
      },
      prefs: async () => await loadPrefs(),
      setPrefs: async (raw) => {
        const input = (raw ?? {}) as Partial<Prefs>
        const current = await loadPrefs()
        const voice = input.voice === undefined ? current.voice : String(input.voice ?? "").trim()
        const next: Prefs = {
          voice,
          rate: input.rate === undefined ? current.rate : clampRate(input.rate),
          autoPlay: input.autoPlay === undefined ? current.autoPlay : input.autoPlay === true,
          keepWarm: input.keepWarm === undefined ? current.keepWarm : input.keepWarm === true,
          pickVoice: input.pickVoice === undefined ? current.pickVoice : input.pickVoice === true,
          fastStart: input.fastStart === undefined ? current.fastStart : input.fastStart === true,
        }
        await ctx.storage.set(PREFS_KEY, { ...next })
        // Picking a local voice should warm the engine immediately so the
        // next read-aloud is already fast.
        if (next.keepWarm && voice.startsWith("piper:")) void warm().catch(() => {})
        return next
      },
    })

    return async () => {
      stopAudioServer()
    }
  },
})
