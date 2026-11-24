/**
 * TTS — the GUI half of the plugin.
 *
 * Talks to the server half over the `tts` RPC domain: it fetches
 * assistant replies, asks for synthesized WAV audio, and plays it through Web
 * Audio (see the audio engine for why). Sessions, the speech engine and user
 * preferences all live on the server side; this file only draws and plays.
 */
import { For, Show, createEffect, createResource, createSignal, onCleanup, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Command, Panel, Plugin, SettingsPage, Slot, type MountedSession } from "@opencode/plugin/gui"
import { TtsRpc, type AudioInfoResult, type CatalogVoice, type Prefs, type ReplyItem, type SpeakResult } from "./rpc"
import { fileLabel, previewedFilePath } from "./preview"
import {
  COPY_WRAPPER_SELECTOR,
  READ_BUTTON_ATTR,
  READ_MENU_ATTR,
  buttonStateFor,
  pickMessageText,
  requiredLeadSec,
  triggerInsidePanel,
  type ButtonState,
} from "./read_aloud"

/** The host components we use; the public types keep the registry open, so we type the calls. */
interface IconProps {
  name: string
  size?: "small" | "normal" | "large"
  class?: string
}

/** `SlotMap["session.header"]`: the session and active fields are reactive getters. */
interface HeaderProps {
  readonly screen: unknown
  readonly session: MountedSession
  readonly active: boolean
  readonly compact: boolean
}

/** `PanelProps`: reactive getters; access through the props object, never destructure. */
interface PanelPropsLike {
  readonly tab: unknown
  readonly session: MountedSession
  readonly screen: unknown
}

interface RpcLike {
  speak(input: { sessionID?: string; messageID?: string; text?: string; voice?: string }): Promise<SpeakResult>
  replies(input: { sessionID: string }): Promise<unknown>
  latest(input: { sessionID: string }): Promise<unknown>
  catalog(input?: object): Promise<unknown>
  audioInfo(input: { sessionID?: string; messageID?: string; text?: string; voice?: string }): Promise<AudioInfoResult>
  prefs(input?: object): Promise<unknown>
  setPrefs(input: Partial<Prefs>): Promise<unknown>
}

/** `voice: ""` means "whatever the server catalog lists first" (installed models). */
const DEFAULT_PREFS: Prefs = { voice: "", rate: 0, autoPlay: false, keepWarm: true, pickVoice: true, fastStart: true }

/**
 * Flatten anything thrown by the SDK into readable text. The client throws
 * plain objects (ApiError/RpcError shapes), which would otherwise render as
 * `[object Object]` in toasts and in the app log.
 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>
    const parts: string[] = []
    if (typeof e._tag === "string") parts.push(e._tag)
    else if (typeof e.name === "string" && e.name) parts.push(e.name)
    if (typeof e.type === "string" && e.type) parts.push(e.type)
    if (typeof e.message === "string" && e.message && !parts.includes(e.message)) parts.push(e.message)
    if (typeof e.status === "number" && e.status) parts.push(`HTTP ${e.status}`)
    if (parts.length) return parts.join(": ").slice(0, 300)
    try {
      const json = JSON.stringify(error)
      if (json && json !== "{}") return json.slice(0, 300)
    } catch {
      // circular — fall through
    }
  }
  return String(error)
}

/**
 * The GUI bundle can mount before the server half of the plugin answers RPC
 * (a cold service boot registers both halves in sequence), so startup reads
 * retry with a gentle backoff instead of leaving defaults silently in place.
 * A service restart plus SDK reconnect can take ~20s, so the schedule covers
 * roughly 30 seconds before giving up.
 */
async function retryRpc<T>(label: string, call: () => Promise<T>, attempts = 10, baseDelayMs = 800): Promise<T | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (attempt === attempts) {
        console.error(`[tts] ${label} failed: ${errorText(error)}`)
        return undefined
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(baseDelayMs * attempt, 5000)))
    }
  }
  return undefined
}

function rateLabel(rate: number): string {
  return rate === 0 ? "1.0x" : `${(1 + rate / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}x`
}

/**
 * Speaker glyph for the read-aloud controls.
 *
 * Drawn here because the host icon catalog has no volume icon at all — its
 * only audio names (`outline-audio`, `outline-wave-audio`, `waveform`) are all
 * bar-graph glyphs — and slots the host renders itself (panel tab, settings
 * page) only accept a catalog name, so those keep the bars.
 * Stroke geometry follows the app's 14-unit icons: stroke-width 1, round caps.
 */
const READ_ICON_AUDIO =
  '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path d="M6.42 2.92 3.5 5.25H1.17v3.5h2.33l2.92 2.33z" stroke="currentColor" stroke-linejoin="round"/>' +
  '<path d="M9.07 4.94a2.92 2.92 0 0 1 0 4.12M11.12 2.88a5.83 5.83 0 0 1 0 8.24" stroke="currentColor" stroke-linecap="round"/>' +
  "</svg>"

/** Host `stop` glyph, shown while one message's audio plays. */
const READ_ICON_STOP =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path d="M13 3H3V13H13V3Z" fill="currentColor"/>' +
  "</svg>"

const READ_STYLE_ID = "oc-tts-read-styles"

/** One injected stylesheet: busy pulse plus the icon slot's inline layout. */
function injectReadStyles() {
  if (document.getElementById(READ_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = READ_STYLE_ID
  style.textContent = `
@keyframes oc-tts-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
[data-oc-tts-read][data-oc-tts-state="busy"] { animation: oc-tts-pulse 1s ease-in-out infinite; }
[data-oc-tts-read] [data-slot="icon-svg"] { display: inline-flex; align-items: center; justify-content: center; }
[data-oc-tts-read-menu] { cursor: pointer; }
`
  document.head.appendChild(style)
}

/**
 * Shared right-click menu (protocol with the dictionary plugin).
 *
 * Several plugins want items in the floating menu shown on messages and
 * the review panel. Replacing that menu wholesale would hide the other
 * plugin's items, so each plugin registers a provider in a small registry
 * on `globalThis`; the first plugin whose listener runs builds one menu
 * from every provider's items. Keep this block in sync with the same
 * block in the dictionary plugin.
 */
interface ContextMenuItem {
  id: string
  owner: string
  label: string
  onSelect: () => void
}
interface ContextMenuContext {
  /** Selected text at right-click time, trimmed. */
  text: string
  inMessage: boolean
  panel: boolean
  inEditor: boolean
}
type ContextMenuProvider = (context: ContextMenuContext) => ContextMenuItem[]
interface ContextMenuEntry {
  /** Lower number sorts earlier in the combined menu. */
  order: number
  provide: ContextMenuProvider
}
interface ContextMenuStore {
  providers: Map<string, ContextMenuEntry>
  /** Marks the event whose combined menu some plugin already rendered. */
  rendered: WeakSet<MouseEvent>
}
const CONTEXT_MENU_KEY = "__opencodeContextMenuBar"
function contextMenuStore(): ContextMenuStore {
  const holder = globalThis as unknown as Record<string, ContextMenuStore | undefined>
  return (holder[CONTEXT_MENU_KEY] ??= { providers: new Map(), rendered: new WeakSet<MouseEvent>() })
}

/**
 * Cross-plugin read-aloud bridge (protocol with the dictionary plugin).
 * The plugin that owns the audio pipeline publishes it on `globalThis`; other
 * plugins call it to speak a word with the user's chosen voice instead of the
 * browser's speechSynthesis, which lacks Japanese voices on many Linux setups.
 * Keep this block in sync with the same block in the dictionary plugin.
 */
interface TtsBridge {
  /** Queues `text` for reading with the current voice. */
  speak: (text: string) => void
  /** Stops the current reading. */
  stop: () => void
}
const TTS_BRIDGE_KEY = "__opencodeTtsBridge"

export default Plugin.define({
  i18n: {
    en: {
      "tts.name": "TTS",
      "tts.panel.title": "TTS",
      "tts.action.play-item": "Read by voice",
      "tts.action.read": "Read by voice",
      "tts.action.read-busy": "Preparing audio…",
      "tts.action.stop": "Stop voice reading",
      "tts.action.refresh": "Reload replies",
      "tts.action.settings": "TTS settings",
      "tts.command.latest": "TTS: read latest reply",
      "tts.command.selection": "TTS: read selection",
      "tts.command.file": "TTS: read open file",
      "tts.command.stop": "TTS: stop",
      "tts.command.open": "TTS: show replies",
      "tts.empty": "No reply to read yet",
      "tts.no-session": "Open a session to read its replies.",
      "tts.reply-count": "{count} replies",
      "tts.error": "TTS failed",
      "tts.settings.title": "TTS",
      "tts.settings.voice": "Default voice",
      "tts.settings.rate": "Speed",
      "tts.settings.voiceNone": "No voice installed",
      "tts.settings.auto-play": "Read new replies by voice when the assistant finishes",
      "tts.settings.keep-warm": "Keep the local engine and audio device warm (faster start, no pop after idle)",
      "tts.settings.pick-voice": "Ask which voice to read with on every read-aloud",
      "tts.settings.fast-start": "Fast start: stream from the resident local engine while synthesizing",
      "tts.pick.title": "Read with which voice?",
      "tts.pick.hint": "Click a voice or press its number — Esc cancels",
      "tts.pick.local": "Local — offline",
      "tts.pick.online": "Online",
      "tts.tag.male": "male",
      "tts.tag.female": "female",
      "tts.tag.child": "child",
      "tts.tag.child-fx": "child-like",
      "tts.context.read": "Read selection",
      "tts.context.stop": "Stop voice reading",
      "tts.context.latest": "Read latest reply",
      "tts.action.file": "Read open file",
      "tts.menu.readPreview": "Read by voice",
      "tts.file.none": "No file is open in the preview panel",
      "tts.file.empty": "No text to read in {file}",
      "tts.file.reading": "Reading {file}",
      "tts.file.failed": "Could not read {file}: {message}",
    },
    ja: {
      "tts.name": "読み上げ",
      "tts.panel.title": "読み上げ",
      "tts.action.play-item": "この返信を読み上げる",
      "tts.action.read": "この返信を読み上げる",
      "tts.action.read-busy": "音声を準備中…",
      "tts.action.stop": "読み上げを停止",
      "tts.action.refresh": "一覧を再読込",
      "tts.action.settings": "読み上げの設定",
      "tts.command.latest": "読み上げ：最新の返信を読み上げる",
      "tts.command.selection": "読み上げ：選択した文字列を読み上げる",
      "tts.command.file": "読み上げ：ファイルを読み上げる",
      "tts.command.stop": "読み上げ：停止",
      "tts.command.open": "読み上げ：返信一覧を表示",
      "tts.empty": "読み上げられる返信がありません",
      "tts.no-session": "セッションを開くと、その返信を読み上げできます。",
      "tts.reply-count": "{count} 件の返信",
      "tts.error": "読み上げに失敗しました",
      "tts.settings.title": "読み上げ",
      "tts.settings.voice": "既定の音声",
      "tts.settings.voiceNone": "音声モデル未インストール",
      "tts.settings.rate": "速度",
      "tts.settings.auto-play": "アシスタントの応答完了後、新しい返信を自動で読み上げる",
      "tts.settings.keep-warm": "ローカルエンジンとオーディオデバイスを起動状態に保つ（読み上げ開始の遅延とポップノイズを軽減）",
      "tts.settings.pick-voice": "読み上げのたびに音声を選ぶダイヤログを表示する",
      "tts.settings.fast-start": "高速開始：常駐サーバーへストリーム送信し、合成しながら再生を開始する",
      "tts.pick.title": "どの音声で読む？",
      "tts.pick.hint": "クリックまたは数字キーで選択 ― Esc でキャンセル",
      "tts.pick.local": "ローカル ― オフライン",
      "tts.pick.online": "オンライン",
      "tts.tag.male": "男性",
      "tts.tag.female": "女性",
      "tts.tag.child": "子供",
      "tts.tag.child-fx": "子供風",
      "tts.context.read": "選択した文字列を読み上げ",
      "tts.context.stop": "読み上げを停止",
      "tts.context.latest": "最新の返信を読み上げ",
      "tts.action.file": "ファイルを読み上げる",
      "tts.menu.readPreview": "音声で読み上げる",
      "tts.file.none": "プレビューパネルに開かれているファイルがありません",
      "tts.file.empty": "{file} に読み上げられる文字列がありません",
      "tts.file.reading": "{file} を読み上げています",
      "tts.file.failed": "{file} を読み込めませんでした: {message}",
    },
  },
  setup(ctx) {
    const rpc = ctx.client.rpc(TtsRpc) as unknown as RpcLike
    // The host Ui registry is open in the public types; we type the icon call.
    const Icon = (ctx.ui as unknown as { Icon: (props: IconProps) => JSX.Element }).Icon

    // ---------- preferences ----------
    const [prefs, setPrefs] = createSignal<Prefs>({ ...DEFAULT_PREFS })
    const [catalog, setCatalog] = createSignal<CatalogVoice[]>([])
    const [defaultVoice, setDefaultVoice] = createSignal("")
    const [catalogNote, setCatalogNote] = createSignal("")
    void retryRpc("prefs", () => rpc.prefs({})).then((value) => {
      if (value) setPrefs(value as Prefs)
    })
    const loadCatalog = () => {
      void retryRpc("catalog", () => rpc.catalog({})).then((value) => {
        if (!value) return
        const result = value as { voices: CatalogVoice[]; defaultVoice?: string; note?: string }
        setCatalog(result.voices ?? [])
        setDefaultVoice(result.defaultVoice ?? "")
        setCatalogNote(result.note ?? "")
      })
    }
    loadCatalog()

    /** The voice a read-aloud uses when the user hasn't picked one this time. */
    const effectiveVoice = () => prefs().voice || defaultVoice()

    const savePrefs = async (patch: Partial<Prefs>) => {
      const next = { ...prefs(), ...patch }
      setPrefs(next)
      try {
        // The server answers with the stored shape (and starts warming the
        // local engine in the background when the new voice is a local one).
        setPrefs((await rpc.setPrefs(next)) as Prefs)
      } catch (error) {
        console.error(`[tts] setPrefs failed: ${errorText(error)}`)
        ctx.toast.show({ title: ctx.t("tts.error"), description: errorText(error), variant: "error" })
      }
    }

    // ---------- audio engine ----------
    //
    // The clip is decoded in full and then played from an AudioBufferSourceNode.
    // Feeding a `data:audio/mpeg` URL to an <audio> element made the first ~3
    // seconds of every clip come out as noise while the bytes themselves
    // measured clean — per 100 ms window, the opening of a clip is
    // indistinguishable from its tail (same silence-then-speech ramp, same
    // fricative bursts, peak 21273, no clipping) — so the artefact was in the
    // element's streaming decode/priming path. Decoding the whole buffer first
    // leaves nothing in flight when sound starts.
    let context: AudioContext | undefined
    let source: AudioBufferSourceNode | undefined
    const streamNodes = new Set<AudioBufferSourceNode>()
    let token = 0
    // When the output device last rendered anything (real clip or silent beat).
    // Output devices here power down after a few idle seconds and pop while
    // powering back up, so this timestamp decides whether a clip needs waking
    // first — a long gap means the device is almost certainly cold again, even
    // much later in the session.
    let lastAudioAt = 0
    const [playingId, setPlayingId] = createSignal("")
    const [busyId, setBusyId] = createSignal("")

    /** Gap past which the device is treated as powered down before playback. */
    const WAKE_GAP_MS = 3000
    /** Silent samples always prepended to a clip, absorbing any residual transient. */
    const LEAD_IN_SEC = 0.12
    /** Length of the silent beat used to wake a cold device, plus settle margin. */
    const WAKE_BEAT_SEC = 0.25
    const WAKE_SETTLE_MS = 150
    /** Keep-alive beat interval (device suspension sits above this cadence). */
    const KEEP_ALIVE_MS = 2000

    /** Render `seconds` of silence to the destination; resolves when done. */
    const silentBeat = async (active: AudioContext, seconds: number): Promise<void> => {
      const node = active.createBufferSource()
      node.buffer = active.createBuffer(1, Math.max(1, Math.round(active.sampleRate * seconds)), active.sampleRate)
      node.connect(active.destination)
      const done = new Promise<void>((resolve) => {
        node.onended = () => {
          node.disconnect()
          resolve()
        }
      })
      node.start()
      lastAudioAt = Date.now()
      await done
    }

    /** True only while decoded audio is running, which is what the stop controls key off. */
    const isPlaying = () => source !== undefined || streamNodes.size > 0

    /** Aborts an in-flight streamed playback (reader loop checks this token). */
    let streamToken = 0

    const halt = () => {
      streamToken += 1
      if (source) {
        source.onended = null
        source.stop()
        source.disconnect()
        source = undefined
      }
      for (const node of streamNodes) {
        node.onended = null
        try {
          node.stop()
        } catch {
          /* already finished */
        }
        node.disconnect()
      }
      streamNodes.clear()
      setPlayingId("")
    }

    const stop = () => {
      token += 1
      halt()
      setBusyId("")
    }

    /**
     * Resume the context and wake a cold output device (silent beat + settle)
     * so the first real sample doesn't land on a power-on pop.
     */
    const wakeOutput = async (myToken: number): Promise<AudioContext> => {
      context ??= new AudioContext()
      // A context created without a user gesture starts suspended; onended
      // timing and resume() rejection are the two ways autoplay fails here.
      await context.resume().catch(() => {
        throw new Error("audio playback blocked")
      })
      const active = context
      const idleMs = Date.now() - lastAudioAt
      if (lastAudioAt && idleMs > WAKE_GAP_MS) {
        // The device has been quiet long enough to power down: wake it with a
        // silent beat so the power-on pop lands on silence, then let it settle
        // before the real clip starts. ~400 ms, once, only after a long gap.
        console.info(`[tts] audio output idle ${Math.round(idleMs / 1000)}s — waking device before playback`)
        await silentBeat(active, WAKE_BEAT_SEC).catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, WAKE_SETTLE_MS))
        if (myToken !== token) throw new Error("cancelled")
        await active.resume().catch(() => {})
      }
      return active
    }

    /** Queue one mono 16-bit PCM segment to start at `earliest`; returns its end time. */
    const schedulePcm = (
      active: AudioContext,
      pcm: Uint8Array,
      sampleRate: number,
      earliest: number,
      playbackRate: number,
      marker: string,
    ): number => {
      const samples = Math.floor(pcm.byteLength / 2)
      if (samples <= 0) return earliest
      const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2)
      const buffer = active.createBuffer(1, samples, sampleRate)
      const channel = buffer.getChannelData(0)
      for (let index = 0; index < samples; index++) channel[index] = view.getInt16(index * 2, true) / 32768
      const node = active.createBufferSource()
      node.buffer = buffer
      node.playbackRate.value = playbackRate
      node.connect(active.destination)
      const start = Math.max(earliest, active.currentTime + 0.01)
      node.onended = () => {
        streamNodes.delete(node)
        if (streamNodes.size === 0 && lastMarker === marker) {
          lastAudioAt = Date.now()
          if (playingId() === marker) setPlayingId("")
        }
      }
      streamNodes.add(node)
      node.start(start)
      return start + buffer.duration / playbackRate
    }

    /** Marker of the most recent stream, so late onended events don't clear a newer play state. */
    let lastMarker = ""

    /**
     * Stream raw PCM from a running `/synth` response and start playing once
     * a synthesis-rate-sized cushion of audio is buffered (about 0.4 s for a
     * warm engine, up to 2 s for a cold one), while the rest of the phrase is
     * still being synthesized. Segments are queued back-to-back on the audio
     * clock, so the seams are inaudible.
     */
    const playStream = async (
      body: ReadableStream<Uint8Array>,
      sampleRate: number,
      marker: string,
      playbackRate: number,
      myToken: number,
    ): Promise<void> => {
      const active = await wakeOutput(myToken)
      if (myToken !== token) return
      const reader = body.getReader()
      const segSec = 0.4
      const segBytes = Math.round(sampleRate * segSec) * 2
      let pending = new Uint8Array(0)
      let stripHeader = true
      let queuedUntil = active.currentTime + 0.02
      let started = false
      lastMarker = marker
      // Arrival throughput (audio seconds per wall-clock second) decides how
      // much of a cushion the start needs; see requiredLeadSec.
      let firstByteAt = 0
      let receivedBytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (myToken !== token) {
          await reader.cancel().catch(() => {})
          return
        }
        if (value && value.byteLength) {
          if (!firstByteAt) firstByteAt = performance.now()
          receivedBytes += value.byteLength
          const merged = new Uint8Array(pending.byteLength + value.byteLength)
          merged.set(pending)
          merged.set(value, pending.byteLength)
          pending = merged
        }
        if (stripHeader) {
          // The server sends a placeholder RIFF/WAVE header (sizes unknown at
          // stream start); it is exactly 44 bytes of the first segment.
          if (!done && pending.byteLength < 44) {
            if (!done) continue
          }
          pending = pending.subarray(Math.min(44, pending.byteLength))
          stripHeader = false
        }
        for (;;) {
          const take = done ? pending.byteLength - (pending.byteLength % 2) : Math.min(pending.byteLength, segBytes)
          const whole = take - (take % 2)
          if (whole < 2 || (!done && whole < segBytes)) break
          if (!started) {
            const bufferedSec = pending.byteLength / 2 / sampleRate
            const elapsedSec = firstByteAt ? (performance.now() - firstByteAt) / 1000 : 0
            const audioSec = Math.max(0, receivedBytes - 44) / 2 / sampleRate
            const rate = elapsedSec > 0.08 ? audioSec / elapsedSec : 0
            // A cold engine outruns playback only barely: hold the start
            // until the buffer covers its measured pace, so segments never
            // arrive after the play head passed their slot.
            if (!done && bufferedSec < requiredLeadSec(rate)) break
          }
          queuedUntil = schedulePcm(active, pending.subarray(0, whole), sampleRate, queuedUntil, playbackRate, marker)
          pending = pending.subarray(whole)
          if (!started) {
            started = true
            setPlayingId(marker)
            lastAudioAt = Date.now()
            // A first segment this short means the server ran out of text
            // mid-stream (tiny replies); playing it is still correct.
          }
        }
        if (done) break
      }
      if (started && myToken === token) setBusyId("")
      if (!started) {
        // Empty synthesis — let the caller's fallback path handle it.
        throw new Error("empty stream")
      }
    }

    async function playAudio(base64: string, marker: string, playbackRate = 1): Promise<void> {
      const myToken = token
      const clip = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const active = await wakeOutput(myToken)
      if (myToken !== token) return
      const buffer = await active.decodeAudioData(clip.buffer as ArrayBuffer).catch(() => {
        throw new Error("audio playback failed")
      })
      // Short silent lead-in on every clip as insurance for gaps the idle
      // check can't see (suspension mid-request, throttled keep-alive while a
      // window is hidden): whatever transient is left plays under silence.
      const lead = Math.max(0, Math.round(active.sampleRate * LEAD_IN_SEC))
      const padded = active.createBuffer(buffer.numberOfChannels, lead + buffer.length, buffer.sampleRate)
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        padded.getChannelData(channel).set(buffer.getChannelData(channel), lead)
      }
      const node = active.createBufferSource()
      node.buffer = padded
      node.playbackRate.value = playbackRate
      node.connect(active.destination)
      node.onended = () => {
        if (source !== node) return
        source = undefined
        lastAudioAt = Date.now()
        if (playingId() === marker) setPlayingId("")
      }
      source = node
      setPlayingId(marker)
      lastAudioAt = Date.now()
      node.start()
    }

    // ---------- engine warm-up and keep-warm ----------
    // On this machine the output device emits a pop while it powers on. That
    // used to hit the session's very first clip; with the load-time warm-up in
    // place the pop instead moved to whichever clip played after an idle gap,
    // because the device suspends a few quiet seconds later and powers back
    // up the same way. Three layers now: silence at load/first gesture primes
    // the engine, a 20 ms silent heartbeat every couple of seconds keeps the
    // device from powering down at all while the app is open (the keepWarm
    // setting), and playAudio() wakes a cold device and pads every clip.
    const warmUp = () => {
      try {
        context ??= new AudioContext()
      } catch {
        return
      }
      const active = context
      void active
        .resume()
        .then(() => {
          if (active.state !== "running") return
          return silentBeat(active, 0.02).catch(() => {})
        })
        .catch(() => {
          /* stay suspended; the next gesture or playAudio() retries */
        })
    }
    warmUp()
    // Autoplay policy may keep the context suspended until a user gesture;
    // the very first click/keypress (even the read-aloud button itself) fires
    // before playback starts, so the pop is still absorbed in time.
    for (const event of ["pointerdown", "keydown"] as const) {
      window.addEventListener(event, warmUp, { once: true })
    }

    // The keep-warm heartbeat, re-armed whenever the setting flips. If the
    // loop stalls (hidden-window timer throttling) or is switched off, the
    // playAudio() idle check still wakes the device, so this is an
    // optimisation rather than the only guard.
    let keepAliveTimer: number | undefined
    createEffect(() => {
      const on = prefs().keepWarm
      if (keepAliveTimer !== undefined) {
        window.clearInterval(keepAliveTimer)
        keepAliveTimer = undefined
      }
      if (!on) return
      keepAliveTimer = window.setInterval(() => {
        if (!context) {
          warmUp()
          return
        }
        if (context.state !== "running" || source) return
        void silentBeat(context, 0.02).catch(() => {})
      }, KEEP_ALIVE_MS)
    })
    onCleanup(() => {
      if (keepAliveTimer !== undefined) window.clearInterval(keepAliveTimer)
    })

    let lastReadId = ""

    /**
     * Read one thing aloud. With `fastStart` the GUI first asks for a synth
     * plan: for local voices the resident sidecar is streaming audio into the
     * speaker while the sentence is still being synthesized. Without a plan
     * (online voices, engine unavailable, stale model list) the full clip
     * arrives through the `speak` RPC instead. `voiceOverride` is the one-click
     * voice picked in the dialog; empty means the stored preference.
     */
    const play = async (
      input: { sessionID?: string; messageID?: string; text?: string },
      marker: string,
      voiceOverride?: string,
    ) => {
      stop()
      const mine = token
      setBusyId(marker)
      const voice = voiceOverride?.trim() || undefined
      try {
        if (prefs().fastStart) {
          try {
            const info = await rpc.audioInfo({ ...input, ...(voice ? { voice } : {}) })
            if (mine !== token) return
            if (info?.url && info.token && info.synth?.text) {
              const response = await fetch(`${info.url}/synth`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-tts-token": info.token },
                body: JSON.stringify(info.synth),
              })
              if (response.ok && response.body) {
                await playStream(
                  response.body,
                  Number(response.headers.get("x-tts-sample-rate")) || 22050,
                  marker,
                  info.playbackRate ?? 1,
                  mine,
                )
                return
              }
            }
          } catch (error) {
            if (mine !== token) return
            console.info(`[tts] fast path unavailable (${errorText(error)}), using speak`)
          }
        }
        const result = await rpc.speak({ ...input, ...(voice ? { voice } : {}) })
        if (mine !== token) return
        if (!result?.audio) {
          ctx.toast.show({ title: ctx.t("tts.empty"), variant: "default" })
          return
        }
        if (result.messageID) lastReadId = result.messageID
        await playAudio(result.audio, marker, result.playbackRate ?? 1)
      } catch (error) {
        if (mine !== token) return
        console.error(`[tts] speak failed: ${errorText(error)}`)
        ctx.toast.show({ title: ctx.t("tts.error"), description: errorText(error), variant: "error" })
      } finally {
        if (busyId() === marker) setBusyId("")
      }
    }

    // ---------- one-click voice picker ----------
    // When `pickVoice` is on, every read-aloud gesture opens the picker for a
    // split second: the row the user clicks (or the number they type) is the
    // voice the phrase is read in. The dialog fires the warm-up itself, so by
    // the time a choice is made the local engine is already spinning.
    const [pickerRequest, setPickerRequest] = createSignal<{
      input: { sessionID?: string; messageID?: string; text?: string }
      marker: string
      nonce: number
    } | null>(null)
    let pickerNonce = 0

    const readWith = (
      input: { sessionID?: string; messageID?: string; text?: string },
      marker: string,
      voiceId?: string,
    ) => {
      if (prefs().pickVoice) {
        // Warm the local engine for the voice the picker will highlight,
        // without waiting for it: the dialog opens over the spinning engine.
        void rpc.audioInfo({ ...input, voice: voiceId ?? effectiveVoice() }).catch(() => {})
        setPickerRequest({ input, marker, nonce: (pickerNonce += 1) })
        return
      }
      void play(input, marker, voiceId ?? effectiveVoice())
    }

    // Publish the read-aloud bridge (see the protocol block above): the
    // dictionary's 🔈 buttons speak through this plugin's engine instead of
    // the browser's speech synthesis.
    const bridge: TtsBridge = {
      speak: (text) => {
        const trimmed = text.trim()
        if (trimmed) readWith({ text: trimmed }, "widget")
      },
      stop,
    }
    const bridgeHolder = globalThis as unknown as Record<string, TtsBridge | undefined>
    bridgeHolder[TTS_BRIDGE_KEY] = bridge
    onCleanup(() => {
      if (bridgeHolder[TTS_BRIDGE_KEY] === bridge) delete bridgeHolder[TTS_BRIDGE_KEY]
    })

    const choosePickerVoice = (voiceId: string) => {
      const request = pickerRequest()
      if (!request) return
      setPickerRequest(null)
      void play(request.input, request.marker, voiceId)
    }

    const playLatest = (session: MountedSession | undefined) => {
      if (!session) return
      readWith({ sessionID: session.id }, "latest")
    }

    const playSelection = () => {
      const text = window.getSelection()?.toString().trim() ?? ""
      if (!text) {
        ctx.toast.show({ title: ctx.t("tts.empty"), variant: "default" })
        return
      }
      readWith({ text }, "selection")
    }

    // ---------- previewed file ----------
    // The host has no "file on screen" accessor, but its review panel keys each
    // file tab `file://<workspace path>` (see preview.ts); we read the selected
    // tab out of the DOM, load that file through the host's file model, and read
    // it back. The server sanitizes and clips the text like any other input.
    const readPreviewedFile = async () => {
      const path = previewedFilePath()
      const files = ctx.screen.current()?.file
      if (!path || !files) {
        ctx.toast.show({ title: ctx.t("tts.file.none"), variant: "default" })
        return
      }
      const name = fileLabel(path)
      let text = ""
      try {
        await files.sync(path, { silent: true })
        const content = files.get(path)?.content
        if (content?.type === "text") text = content.content
      } catch (error) {
        ctx.toast.show({ title: ctx.t("tts.file.failed", { file: name, message: errorText(error) }), variant: "error" })
        return
      }
      if (!text.trim()) {
        ctx.toast.show({ title: ctx.t("tts.file.empty", { file: name }), variant: "default" })
        return
      }
      ctx.toast.show({ title: ctx.t("tts.file.reading", { file: name }), variant: "default" })
      readWith({ text }, "file")
    }

    // ---------- auto play ----------
    // One event stream for the window: on `session.idle`, read the reply the
    // assistant just finished, if it is the session on screen and nothing is playing.
    const autoAbort = new AbortController()
    onCleanup(() => autoAbort.abort())
    void (async () => {
      try {
        const stream = ctx.client.event.subscribe({
          types: ["session.idle"],
          signal: autoAbort.signal,
        }) as unknown as AsyncIterable<{ type?: string; data?: { sessionID?: string } }>
        for await (const event of stream) {
          if (autoAbort.signal.aborted) return
          if (event.type !== "session.idle") continue
          if (!prefs().autoPlay) continue
          if (isPlaying()) continue
          const current = ctx.sessions.current()
          if (!current || current.id !== event.data?.sessionID) continue
          const latest = (await rpc.latest({ sessionID: current.id })) as { reply?: ReplyItem | null }
          const reply = latest.reply
          if (!reply || reply.id === lastReadId) continue
          lastReadId = reply.id
          if (autoAbort.signal.aborted) return
          await play({ text: reply.text }, reply.id)
        }
      } catch (error) {
        if (!autoAbort.signal.aborted) console.error("[tts] auto play", error)
      }
    })()

    // ---------- contributions ----------
    const openPanel = () => {
      const target = ctx.sessions.current()
      if (target) ctx.layout.open(`${ctx.id}:replies`, target, { tab: "select" })
    }

    ctx.add(Command, {
      id: "tts.speak-latest",
      get title() {
        return ctx.t("tts.command.latest")
      },
      run: () => playLatest(ctx.sessions.current()),
    })
    ctx.add(Command, {
      id: "tts.speak-selection",
      get title() {
        return ctx.t("tts.command.selection")
      },
      keywords: "selection selection TTS speech",
      run: playSelection,
    })
    ctx.add(Command, {
      id: "tts.speak-file",
      get title() {
        return ctx.t("tts.command.file")
      },
      keywords: "file preview read aloud document",
      run: () => void readPreviewedFile(),
    })
    ctx.add(Command, {
      id: "tts.stop",
      get title() {
        return ctx.t("tts.command.stop")
      },
      run: stop,
    })
    ctx.add(Command, {
      id: "tts.open",
      get title() {
        return ctx.t("tts.command.open")
      },
      run: openPanel,
    })

    // ---------- chat-header control ----------
    // Sits right of the session title. Idle it reads the latest reply; while
    // *any* audio plays — message button, selection, file, this button — it
    // becomes the stop control, so playback can be stopped from anywhere.
    ctx.add(Slot, {
      at: "session.header",
      order: 35,
      render: (props: HeaderProps) => (
        <Show when={props.active}>
          <Show
            when={playingId() || busyId()}
            fallback={
              <button
                type="button"
                title={ctx.t("tts.command.latest")}
                aria-label={ctx.t("tts.command.latest")}
                onClick={() => playLatest(props.session)}
                style={{
                  display: "inline-flex",
                  "align-items": "center",
                  "justify-content": "center",
                  height: "24px",
                  padding: "0 6px",
                  background: "transparent",
                  border: "none",
                  "border-radius": "4px",
                  cursor: "pointer",
                  color: "inherit",
                }}
              >
                <span innerHTML={READ_ICON_AUDIO} />
              </button>
            }
          >
            <button
              type="button"
              title={ctx.t("tts.context.stop")}
              aria-label={ctx.t("tts.context.stop")}
              onClick={stop}
              style={{
                display: "inline-flex",
                "align-items": "center",
                "justify-content": "center",
                height: "24px",
                padding: "0 6px",
                background: "transparent",
                border: "none",
                "border-radius": "4px",
                cursor: "pointer",
                color: "inherit",
              }}
            >
              <span innerHTML={READ_ICON_STOP} />
            </button>
          </Show>
        </Show>
      ),
    })

    // ---------- read-aloud controls ----------
    // A button next to each reply's copy button, plus items in the Preview
    // panel's tab right-click and kebab menus (see ReadControls below).
    // The host has no registry for either, so the component injects into the
    // DOM and mounts nothing itself.
    ctx.add(Slot, {
      at: "window.bottom",
      render: () => (
        <>
          <ReadControls />
          <SelectionMenu />
          <VoiceDialog />
        </>
      ),
    })

    // ---------- one-click voice picker ----------
    /**
     * Modal shown for every read-aloud gesture while `pickVoice` is on. Rows
     * are the server catalog grouped into local/online; a click (or the row's
     * number key) starts the reading in that voice immediately. The dialog is
     * mounted in the always-present window slot so it appears over whatever
     * view the gesture came from, and it renders through a Portal so panel
     * overflow styles cannot clip it.
     */
    function VoiceDialog() {
      const palette = menuPalette()
      const groups = (): { title: string; voices: CatalogVoice[] }[] => {
        const all = catalog()
        const local = all.filter((voice) => !voice.online)
        const online = all.filter((voice) => voice.online)
        const out: { title: string; voices: CatalogVoice[] }[] = []
        if (local.length) out.push({ title: ctx.t("tts.pick.local"), voices: local })
        if (online.length) out.push({ title: ctx.t("tts.pick.online"), voices: online })
        return out
      }
      /** Display order flattened — number keys 1..9 map onto it. */
      const flat = () => groups().flatMap((group) => group.voices)
      const tagsOf = (voice: CatalogVoice): string[] => {
        const tags: string[] = []
        if (voice.gender === "male") tags.push(ctx.t("tts.tag.male"))
        if (voice.gender === "female") tags.push(ctx.t("tts.tag.female"))
        if (voice.child) tags.push(ctx.t(voice.fx ? "tts.tag.child-fx" : "tts.tag.child"))
        if (voice.engine === "voicevox") tags.push("VOICEVOX")
        return tags
      }

      const onKeyDown = (event: KeyboardEvent) => {
        if (!pickerRequest()) return
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          setPickerRequest(null)
          return
        }
        const index = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1
        const voice = index >= 0 ? flat()[index] : undefined
        if (voice) {
          event.preventDefault()
          event.stopPropagation()
          choosePickerVoice(voice.id)
        }
      }
      window.addEventListener("keydown", onKeyDown, true)
      onCleanup(() => window.removeEventListener("keydown", onKeyDown, true))

      // Nothing to pick before the catalog arrives (or with no voices at all):
      // don't strand the gesture on an empty dialog, just read with defaults.
      createEffect(() => {
        if (pickerRequest() && catalog().length === 0) choosePickerVoice("")
      })

      return (
        <Show when={pickerRequest()}>
          <Portal>
            <div
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setPickerRequest(null)
              }}
              style={{
                position: "fixed",
                inset: "0",
                "z-index": "2147483646",
                background: "rgba(0, 0, 0, 0.35)",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={ctx.t("tts.pick.title")}
                style={{
                  "min-width": "320px",
                  "max-width": "440px",
                  "max-height": "70vh",
                  "overflow-y": "auto",
                  background: palette.background,
                  color: palette.color,
                  border: palette.border,
                  "border-radius": "10px",
                  padding: "10px 10px 8px",
                  "box-shadow": "0 12px 40px rgba(0, 0, 0, 0.45)",
                  "font-size": "13px",
                }}
              >
                <p style={{ margin: "2px 6px 8px", "font-weight": "600" }}>{ctx.t("tts.pick.title")}</p>
                <For each={groups()}>
                  {(group) => (
                    <>
                      <p
                        style={{
                          margin: "6px 6px 2px",
                          "font-size": "11px",
                          "letter-spacing": "0.04em",
                          opacity: "0.6",
                        }}
                      >
                        {group.title}
                      </p>
                      <For each={group.voices}>
                        {(voice) => {
                          const index = () => flat().indexOf(voice)
                          const isDefault = () => voice.id === effectiveVoice()
                          return (
                            <button
                              type="button"
                              onClick={() => choosePickerVoice(voice.id)}
                              onPointerDown={(event) => event.preventDefault()}
                              onMouseEnter={(event) => (event.currentTarget.style.background = palette.hover)}
                              onMouseLeave={(event) =>
                                (event.currentTarget.style.background = isDefault() ? palette.hover : "transparent")
                              }
                              style={{
                                display: "flex",
                                "align-items": "center",
                                gap: "8px",
                                width: "100%",
                                "text-align": "left",
                                background: isDefault() ? palette.hover : "transparent",
                                border: "none",
                                "border-radius": "6px",
                                color: "inherit",
                                "font-size": "13px",
                                "font-family": "inherit",
                                padding: "7px 8px",
                                cursor: "pointer",
                              }}
                            >
                              <span
                                style={{
                                  "flex-shrink": "0",
                                  width: "16px",
                                  opacity: index() >= 0 && index() < 9 ? "0.55" : "0",
                                  "font-size": "11px",
                                }}
                              >
                                {index() >= 0 && index() < 9 ? index() + 1 : ""}
                              </span>
                              <span style={{ flex: "1" }}>{voice.label}</span>
                              <For each={tagsOf(voice)}>
                                {(tag) => (
                                  <span
                                    style={{
                                      "flex-shrink": "0",
                                      "font-size": "10px",
                                      padding: "1px 6px",
                                      "border-radius": "999px",
                                      border: `1px solid ${palette.border.replace(/^1px solid /, "")}`,
                                      opacity: "0.75",
                                    }}
                                  >
                                    {tag}
                                  </span>
                                )}
                              </For>
                            </button>
                          )
                        }}
                      </For>
                    </>
                  )}
                </For>
                <p style={{ margin: "8px 6px 2px", "font-size": "11px", opacity: "0.55" }}>{ctx.t("tts.pick.hint")}</p>
              </div>
            </div>
          </Portal>
        </Show>
      )
    }

    const tab = {
      id: "replies",
      get title() {
        return ctx.t("tts.panel.title")
      },
      icon: "waveform" as const,
      closable: "hover" as const,
      fallback: true,
    }

    ctx.add(Panel, {
      id: "tts",
      region: "side",
      list: () => [tab],
      render: (props: PanelPropsLike) => <PanelView host={props} />,
    })

    function PanelView(props: { host: PanelPropsLike }) {
      const [replies, { refetch }] = createResource(
        () => props.host.session?.id,
        async (id) => {
          if (!id) return []
          const result = (await rpc.replies({ sessionID: id })) as { replies: ReplyItem[] }
          return result.replies ?? []
        },
      )
      const items = () => (replies() ?? []) as ReplyItem[]
      return (
        <div class="ra-panel" style={{ display: "flex", "flex-direction": "column", height: "100%", "font-size": "13px" }}>
          <div
            class="ra-toolbar"
            style={{
              display: "flex",
              "align-items": "center",
              gap: "4px",
              padding: "6px 8px",
              "border-bottom": "1px solid var(--color-border-weak, rgba(128,128,128,0.25))",
            }}
          >
            <Show when={props.host.session}>
              <span style={{ "margin-right": "auto", opacity: 0.7 }}>{ctx.t("tts.reply-count", { count: String(items().length) })}</span>
            </Show>
            <Show when={!props.host.session}>
              <span style={{ "margin-right": "auto", opacity: 0.7 }}>{ctx.t("tts.no-session")}</span>
            </Show>
            <ToolButton title={ctx.t("tts.action.refresh")} icon="refresh" onClick={() => void refetch()} />
            <Show when={playingId() || busyId()}>
              <ToolButton title={ctx.t("tts.action.stop")} icon="stop" onClick={stop} />
            </Show>
            <ToolButton title={ctx.t("tts.action.settings")} icon="settings-gear" onClick={() => ctx.layout.settings(ctx.id)} />
          </div>
          <div style={{ flex: "1", "overflow-y": "auto", padding: "4px" }}>
            <Show when={!replies.loading && items().length === 0}>
              <p style={{ padding: "12px 8px", opacity: 0.6 }}>{ctx.t("tts.empty")}</p>
            </Show>
            <For each={items()}>
              {(item) => {
                const isPlaying = () => playingId() === item.id
                const isBusy = () => busyId() === item.id
                return (
                  <div
                    class="ra-item"
                    style={{ display: "flex", "align-items": "flex-start", gap: "6px", padding: "4px", "border-radius": "6px" }}
                  >
                    <button
                      type="button"
                      title={ctx.t("tts.action.play-item")}
                      aria-label={ctx.t("tts.action.play-item")}
                      onClick={() => {
                        if (isPlaying()) stop()
                        else if (!isBusy()) readWith({ text: item.text }, item.id)
                      }}
                      style={{
                        flex: "none",
                        display: "inline-flex",
                        "align-items": "center",
                        "justify-content": "center",
                        width: "24px",
                        height: "24px",
                        background: isPlaying() || isBusy() ? "var(--color-background-interactive, rgba(128,128,128,0.2))" : "transparent",
                        border: "1px solid var(--color-border-weak, rgba(128,128,128,0.25))",
                        "border-radius": "4px",
                        cursor: "pointer",
                        color: "inherit",
                      }}
                    >
                      {isBusy() ? (
                        <Icon name="refresh" size="small" />
                      ) : (
                        <span innerHTML={isPlaying() ? READ_ICON_STOP : READ_ICON_AUDIO} />
                      )}
                    </button>
                    <span style={{ "line-height": "1.5", "user-select": "text" }} title={item.preview}>
                      {item.preview}
                    </span>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      )
    }

    function ToolButton(props: { title: string; icon: string; onClick: () => void }) {
      return (
        <button
          type="button"
          title={props.title}
          aria-label={props.title}
          onClick={props.onClick}
          style={{
            display: "inline-flex",
            "align-items": "center",
            "justify-content": "center",
            width: "24px",
            height: "24px",
            background: "transparent",
            border: "none",
            "border-radius": "4px",
            cursor: "pointer",
            color: "inherit",
          }}
        >
          <Icon name={props.icon} size="small" />
        </button>
      )
    }

    /**
     * Dark or light colours for the floating menu, judged from the window
     * background. A function declaration (not a `const` arrow) on purpose:
     * the host mounts slot components while `setup` is still running, so a
     * `const` declared here would still be in its temporal dead zone when
     * `VoiceDialog` renders and the whole plugin would fail to load.
     */
    function menuPalette() {
      const bg = getComputedStyle(document.body).backgroundColor
      const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/.exec(bg)
      let dark = true
      if (rgb) dark = (Number(rgb[1]) * 299 + Number(rgb[2]) * 587 + Number(rgb[3]) * 114) / 1000 < 128
      return dark
        ? { background: "#26262b", color: "#e9e9ea", border: "1px solid rgba(255,255,255,0.14)", hover: "rgba(255,255,255,0.10)" }
        : { background: "#ffffff", color: "#232326", border: "1px solid rgba(0,0,0,0.18)", hover: "rgba(0,0,0,0.06)" }
    }



    /**
     * Floating right-click menu for the message list and the review panel.
     * TTS contributes: read the selection when there is one, otherwise the
     * latest reply or the open file, plus stop whenever audio runs. Other
     * plugins' providers contribute their own rows into the same menu.
     */
    function SelectionMenu(): JSX.Element {
      const [menu, setMenu] = createSignal<{ x: number; y: number; text: string; items: ContextMenuItem[] } | null>(null)
      const store = contextMenuStore()
      let el: HTMLDivElement | undefined

      const close = () => setMenu(null)

      const provide: ContextMenuProvider = (context) => {
        if ((!context.inMessage && !context.panel) || context.inEditor) return []
        const playing = Boolean(playingId()) || Boolean(busyId())
        const items: ContextMenuItem[] = []
        if (context.text) {
          items.push({
            id: "tts.read",
            owner: "tts",
            label: ctx.t("tts.context.read"),
            onSelect: () => readWith({ text: context.text }, "selection"),
          })
        } else if (!playing) {
          if (context.panel)
            items.push({ id: "tts.file", owner: "tts", label: ctx.t("tts.action.file"), onSelect: () => void readPreviewedFile() })
          else
            items.push({
              id: "tts.latest",
              owner: "tts",
              label: ctx.t("tts.context.latest"),
              onSelect: () => playLatest(ctx.sessions.current()),
            })
        }
        if (playing) items.push({ id: "tts.stop", owner: "tts", label: ctx.t("tts.context.stop"), onSelect: () => stop() })
        return items
      }
      store.providers.set("tts", { order: 10, provide })
      onCleanup(() => store.providers.delete("tts"))

      const onContextMenu = (event: MouseEvent) => {
        if (event.defaultPrevented) return
        if (el && event.target instanceof Node && el.contains(event.target)) return
        // The review panel shows files in a CodeMirror `.cm-content` that is
        // contenteditable but read-only in practice, so selections there count;
        // only the composer's editors are excluded.
        const panel = event.target instanceof Element && event.target.closest("#review-panel") != null
        const codeView = event.target instanceof Element && event.target.closest(".cm-content") != null
        let inMessage = false
        let inEditor = false
        for (const node of event.composedPath()) {
          if (!(node instanceof Element)) continue
          if (!inMessage && node.hasAttribute("data-message-id")) inMessage = true
          if (!inEditor && (node.tagName === "TEXTAREA" || node.tagName === "INPUT")) inEditor = true
          if (!inEditor && !panel && !codeView && node instanceof HTMLElement && node.isContentEditable) inEditor = true
          if (inMessage && inEditor) break
        }
        const context: ContextMenuContext = { text: window.getSelection()?.toString().trim() ?? "", inMessage, panel, inEditor }
        const items: ContextMenuItem[] = []
        for (const entry of [...store.providers.values()].sort((a, b) => a.order - b.order)) {
          try {
            items.push(...entry.provide(context))
          } catch {
            // One plugin's provider must never break the shared menu.
          }
        }
        if (items.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        if (store.rendered.has(event)) return
        store.rendered.add(event)
        setMenu({
          x: Math.max(4, Math.min(event.clientX, window.innerWidth - 280)),
          y: Math.max(4, Math.min(event.clientY, window.innerHeight - 120)),
          text: context.text,
          items,
        })
      }

      const onPointerDown = (event: PointerEvent) => {
        if (menu() && el && event.target instanceof Node && !el.contains(event.target)) close()
      }
      const onKeyDown = (event: KeyboardEvent) => {
        if (menu() && event.key === "Escape") close()
      }
      const onScroll = () => {
        if (menu()) close()
      }
      window.addEventListener("contextmenu", onContextMenu, true)
      window.addEventListener("pointerdown", onPointerDown, true)
      window.addEventListener("keydown", onKeyDown, true)
      window.addEventListener("scroll", onScroll, true)
      window.addEventListener("blur", close)
      onCleanup(() => {
        window.removeEventListener("contextmenu", onContextMenu, true)
        window.removeEventListener("pointerdown", onPointerDown, true)
        window.removeEventListener("keydown", onKeyDown, true)
        window.removeEventListener("scroll", onScroll, true)
        window.removeEventListener("blur", close)
      })

      return (
        <Show when={menu()}>
          {(entry) => {
            const palette = menuPalette()
            const preview = entry().text.replace(/\s+/g, " ")
            return (
              <Portal mount={document.body}>
                <div
                  ref={el}
                  data-tts-selection-menu=""
                  role="menu"
                  style={{
                    position: "fixed",
                    left: `${entry().x}px`,
                    top: `${entry().y}px`,
                    "z-index": "2147483647",
                    "min-width": "200px",
                    "max-width": "300px",
                    background: palette.background,
                    color: palette.color,
                    border: palette.border,
                    "border-radius": "8px",
                    padding: "4px",
                    "box-shadow": "0 10px 28px rgba(0,0,0,0.45)",
                    "font-size": "13px",
                    "font-family": "system-ui, sans-serif",
                    "user-select": "none",
                  }}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <Show when={entry().text}>
                    <div style={{ padding: "4px 8px 6px", opacity: "0.55", "white-space": "nowrap", "text-overflow": "ellipsis", overflow: "hidden" }}>
                      {preview.length > 40 ? `${preview.slice(0, 40)}…` : preview}
                    </div>
                  </Show>
                  <For each={entry().items}>
                    {(item) => (
                      <MenuRow
                        label={item.label}
                        hover={palette.hover}
                        onClick={() => {
                          close()
                          item.onSelect()
                        }}
                      />
                    )}
                  </For>
                </div>
              </Portal>
            )
          }}
        </Show>
      )
    }

    function MenuRow(props: { label: string; hover: string; onClick: () => void }) {
      return (
        <button
          type="button"
          role="menuitem"
          onClick={props.onClick}
          onPointerDown={(event) => event.preventDefault()}
          onMouseEnter={(event) => (event.currentTarget.style.background = props.hover)}
          onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
          style={{
            display: "block",
            width: "100%",
            "text-align": "left",
            background: "transparent",
            border: "none",
            "border-radius": "5px",
            color: "inherit",
            "font-size": "13px",
            "font-family": "inherit",
            padding: "6px 8px",
            cursor: "pointer",
          }}
        >
          {props.label}
        </button>
      )
    }

    /**
     * Injects the per-message play button into every reply's hover toolbar
     * (next to the copy button) and a play/stop item into the Kobalte menus
     * opened from inside the Preview panel (tab right-click and kebab).
     * The SDK has no registry for either, so a MutationObserver watches the
     * host DOM; the component itself renders nothing.
     */
    function ReadControls(): JSX.Element {
      const panelSelector = "#review-panel"
      let scanTimer: number | undefined
      let observer: MutationObserver | undefined

      // Kobalte portals menus to document.body, so by the time we see one the
      // pointer target has moved into the menu; remember the element that was
      // pressed or right-clicked last to judge where the menu came from.
      let lastTrigger: Element | null = null
      let lastTriggerAt = 0
      const rememberTrigger = (event: Event) => {
        if (event.target instanceof Element) {
          lastTrigger = event.target
          lastTriggerAt = Date.now()
        }
      }

      const iconMarkup = (state: ButtonState) =>
        `<span data-slot="icon-svg" style="display:inline-flex;align-items:center;justify-content:center">${
          state === "playing" ? READ_ICON_STOP : READ_ICON_AUDIO
        }</span>`

      /** Push the shared play state into one (non-reactive) injected button. */
      const applyState = (button: HTMLElement) => {
        const own = button.getAttribute("data-oc-tts-message") ?? ""
        const state = buttonStateFor(own, playingId(), busyId())
        if (button.getAttribute("data-oc-tts-state") !== state) {
          button.setAttribute("data-oc-tts-state", state)
          button.innerHTML = iconMarkup(state)
        }
        const label =
          state === "playing" ? ctx.t("tts.action.stop") : state === "busy" ? ctx.t("tts.action.read-busy") : ctx.t("tts.action.read")
        button.title = label
        button.setAttribute("aria-label", label)
      }

      const syncStates = () => {
        for (const button of document.querySelectorAll<HTMLElement>(`[${READ_BUTTON_ATTR}]`)) applyState(button)
        // Keep an injected menu item's label honest while its popup stays open
        // across playback state changes.
        for (const item of document.querySelectorAll<HTMLElement>(`[${READ_MENU_ATTR}]`))
          item.textContent = playingId() || busyId() ? ctx.t("tts.context.stop") : ctx.t("tts.menu.readPreview")
      }

      const scanButtons = () => {
        for (const wrapper of document.querySelectorAll(COPY_WRAPPER_SELECTOR)) {
          if (wrapper.querySelector(`[${READ_BUTTON_ATTR}]`)) continue
          const scope = wrapper.closest("[data-message-id]")
          if (!scope) continue
          // One button per message: later text parts of the same reply share it.
          if (scope.querySelector(`[${READ_BUTTON_ATTR}]`)) continue
          const button = document.createElement("button")
          button.type = "button"
          // Host button attributes give the app's own ghost-icon look.
          button.setAttribute("data-component", "icon-button-v2")
          button.setAttribute("data-size", "small")
          button.setAttribute("data-variant", "ghost-muted")
          button.setAttribute(READ_BUTTON_ATTR, "")
          button.setAttribute("data-oc-tts-message", scope.getAttribute("data-message-id") ?? "")
          button.setAttribute("data-oc-tts-state", "idle")
          button.innerHTML = iconMarkup("idle")
          // Last child of the hover toolbar, so it inherits its layout.
          wrapper.appendChild(button)
          applyState(button)
        }
      }

      const scheduleScan = () => {
        if (scanTimer !== undefined) return
        scanTimer = window.setTimeout(() => {
          scanTimer = undefined
          scanButtons()
        }, 120)
      }

      const injectMenuItem = (menu: Element) => {
        // One popup can hold several role=menu sections (and nested menus);
        // only the outermost element of the first section takes the item, so
        // the same item never appears twice in one menu.
        if (menu.parentElement?.closest('[role="menu"]')) return
        if (menu.closest("[data-tts-selection-menu], [data-oc-ctx-menu]")) return
        // With an active text selection the floating menu already offers to
        // read it (plus stop while playing), so the host menu gets no item;
        // one injected by an earlier idle right-click is dropped here.
        if (window.getSelection()?.toString().trim()) {
          for (const stale of document.querySelectorAll(`[${READ_MENU_ATTR}]`)) stale.remove()
          return
        }
        const popupRoot = menu.closest('[data-slot="context-menu-dropdown"]') ?? menu
        if (popupRoot.querySelector(`[${READ_MENU_ATTR}]`)) return
        if (Date.now() - lastTriggerAt > 800) return
        if (!triggerInsidePanel(lastTrigger, panelSelector)) return
        const template = menu.querySelector(`[role="menuitem"]:not([${READ_MENU_ATTR}])`)
        if (!template) return
        // Clone for the host's item styling; cloneNode copies no listeners, so
        // the clone is inert until the delegated click handler below takes it.
        const item = template.cloneNode(true) as HTMLElement
        item.removeAttribute("id")
        item.removeAttribute("data-highlighted")
        item.removeAttribute("data-disabled")
        item.removeAttribute("aria-disabled")
        item.removeAttribute("aria-haspopup")
        item.setAttribute("role", "menuitem")
        item.setAttribute(READ_MENU_ATTR, "")
        // One item, two faces: play the open file while idle, stop while any
        // audio plays or is being prepared.
        item.textContent = playingId() || busyId() ? ctx.t("tts.context.stop") : ctx.t("tts.menu.readPreview")
        menu.appendChild(item)
      }

      const scanMenus = () => {
        for (const menu of document.querySelectorAll('[role="menu"]')) injectMenuItem(menu)
      }

      const closeHostMenus = () => {
        for (const menu of document.querySelectorAll('[role="menu"]')) {
          menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
        }
      }

      const readMessage = (button: HTMLElement) => {
        const own = button.getAttribute("data-oc-tts-message") ?? ""
        const state = buttonStateFor(own, playingId(), busyId())
        if (state === "playing") stop()
        else if (state === "busy") return
        else {
          const scope = button.closest("[data-message-id]")
          const text = scope ? pickMessageText(scope) : ""
          if (!text) {
            ctx.toast.show({ title: ctx.t("tts.empty"), variant: "default" })
            return
          }
          readWith({ text }, own || "message")
        }
      }

      const onClick = (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return
        const menuItem = event.target.closest(`[${READ_MENU_ATTR}]`)
        if (menuItem) {
          // Capture phase stops the click before Kobalte resolves it against
          // the item we cloned from, then Escape closes the menu.
          event.preventDefault()
          event.stopPropagation()
          closeHostMenus()
          if (playingId() || busyId()) stop()
          else void readPreviewedFile()
          return
        }
        const button = event.target.closest(`[${READ_BUTTON_ATTR}]`)
        if (button instanceof HTMLElement) {
          event.preventDefault()
          event.stopPropagation()
          readMessage(button)
        }
      }

      document.addEventListener("pointerdown", rememberTrigger, true)
      document.addEventListener("contextmenu", rememberTrigger, true)
      document.addEventListener("click", onClick, true)
      observer = new MutationObserver(() => {
        scanMenus()
        scheduleScan()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      injectReadStyles()
      scanButtons()
      scanMenus()

      // Injected DOM is not reactive, so push play-state changes into it.
      createEffect(() => {
        playingId()
        busyId()
        syncStates()
      })

      onCleanup(() => {
        observer?.disconnect()
        if (scanTimer !== undefined) window.clearTimeout(scanTimer)
        document.removeEventListener("pointerdown", rememberTrigger, true)
        document.removeEventListener("contextmenu", rememberTrigger, true)
        document.removeEventListener("click", onClick, true)
      })

      return null
    }

    ctx.add(SettingsPage, {
      id: "tts",
      get title() {
        return ctx.t("tts.settings.title")
      },
      icon: "outline-audio",
      render: () => <SettingsView />,
    })

    function SettingsView() {
      /** Catalog grouped like the picker; the select reuses the same order. */
      const groups = () => {
        const all = catalog()
        const local = all.filter((voice) => !voice.online)
        const online = all.filter((voice) => voice.online)
        const out: { title: string; voices: CatalogVoice[] }[] = []
        if (local.length) out.push({ title: ctx.t("tts.pick.local"), voices: local })
        if (online.length) out.push({ title: ctx.t("tts.pick.online"), voices: online })
        return out
      }
      const tagOf = (voice: CatalogVoice) => {
        if (voice.gender === "male") return ` — ${ctx.t("tts.tag.male")}`
        if (voice.gender === "female") return ` — ${ctx.t("tts.tag.female")}`
        return ""
      }
      return (
        <div style={{ display: "flex", "flex-direction": "column", gap: "16px", padding: "4px 0", "font-size": "13px" }}>
          <label style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <span>{ctx.t("tts.settings.voice")}</span>
            <select
              value={effectiveVoice()}
              disabled={catalog().length === 0}
              onChange={(event) => void savePrefs({ voice: event.currentTarget.value })}
              style={{ "align-self": "flex-start", padding: "4px 8px", "min-width": "280px" }}
            >
              <Show
                when={catalog().length > 0}
                fallback={<option value="">{ctx.t("tts.settings.voiceNone")}</option>}
              >
                <For each={groups()}>
                  {(group) => (
                    <optgroup label={group.title}>
                      <For each={group.voices}>
                        {(voice) => <option value={voice.id}>{voice.label}{tagOf(voice)}</option>}
                      </For>
                    </optgroup>
                  )}
                </For>
              </Show>
            </select>
            <Show when={catalogNote()}>
              <span style={{ "max-width": "480px", color: "var(--text-weak, inherit)" }}>{catalogNote()}</span>
            </Show>
          </label>
          <label style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <span>
              {ctx.t("tts.settings.rate")} — {rateLabel(prefs().rate)}
            </span>
            <input
              type="range"
              min={-50}
              max={50}
              step={5}
              value={prefs().rate}
              onInput={(event) => void savePrefs({ rate: Number(event.currentTarget.value) })}
              style={{ "align-self": "flex-start", width: "240px" }}
            />
          </label>
          <label style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <input
              type="checkbox"
              checked={prefs().pickVoice}
              onChange={(event) => void savePrefs({ pickVoice: event.currentTarget.checked })}
            />
            <span>{ctx.t("tts.settings.pick-voice")}</span>
          </label>
          <label style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <input
              type="checkbox"
              checked={prefs().fastStart}
              onChange={(event) => void savePrefs({ fastStart: event.currentTarget.checked })}
            />
            <span>{ctx.t("tts.settings.fast-start")}</span>
          </label>
          <label style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <input
              type="checkbox"
              checked={prefs().keepWarm}
              onChange={(event) => void savePrefs({ keepWarm: event.currentTarget.checked })}
            />
            <span>{ctx.t("tts.settings.keep-warm")}</span>
          </label>
          <label style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <input
              type="checkbox"
              checked={prefs().autoPlay}
              onChange={(event) => void savePrefs({ autoPlay: event.currentTarget.checked })}
            />
            <span>{ctx.t("tts.settings.auto-play")}</span>
          </label>
        </div>
      )
    }
  },
})
