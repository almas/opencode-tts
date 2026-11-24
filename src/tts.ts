/**
 * Local speech synthesis: Piper, run as a child process.
 *
 * Everything happens on this machine — the text never leaves it. The engine is
 * the `piper` CLI (`uv tool install piper-tts --with pyopenjtalk-plus`) plus a
 * voice model directory (default `~/.local/share/opencode-tts/voices`,
 * override with `OC_TTS_VOICES_DIR`; the binary itself can be overridden with
 * `OC_TTS_PIPER_BIN`). Each `*.onnx` model with its `*.onnx.json` sidecar is
 * offered as one voice per speaker the model defines.
 *
 * The optional online alternative (Microsoft Edge voices) lives in `edge.ts`
 * and is only used when the user selects it in settings; this file stays the
 * default and needs no network.
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir, readFile, unlink } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/** Replies longer than this are cut at a sentence; anything more is tedious. */
export const MAX_SPEECH_CHARACTERS = 6000

/** Directory the voice models are expected in (unless `OC_TTS_VOICES_DIR`). */
export function defaultVoicesDir(): string {
  return process.env.OC_TTS_VOICES_DIR?.trim() || join(homedir(), ".local", "share", "opencode-tts", "voices")
}

/** Where a voice model's sidecar config lives. */
function configPath(modelPath: string): string {
  return `${modelPath}.json`
}

/* ------------------------------------------------------------ engine lookup */

/**
 * The piper executable: explicit override first, then the usual install
 * locations, then $PATH. Null when piper is not installed.
 */
export function resolvePiperBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.OC_TTS_PIPER_BIN?.trim()
  if (override) return existsSync(override) ? override : null
  const candidates = [
    join(env.HOME ?? homedir(), ".local", "bin", "piper"),
    "/usr/local/bin/piper",
    "/usr/bin/piper",
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue
    const candidate = join(dir, "piper")
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** One synthesizable voice: a model file plus one of its speakers. */
export interface PiperVoice {
  /** Stable id: `<model stem>#<speaker index>`. */
  readonly id: string
  /** Human label for the settings list. */
  readonly label: string
  /** Absolute path of the `.onnx` model. */
  readonly model: string
  /** Speaker index within the model. */
  readonly speaker: number
}

type VoiceConfig = {
  num_speakers?: number
  default_speaker_id?: number
  speaker_id_map?: Record<string, number>
  language?: { name_english?: string; name_native?: string }
  dataset?: string
}

/** Pretty name for a speaker key (`female` → `女性`, `male` → `男性`). */
function speakerLabel(key: string, index: number): string {
  if (key === "female") return "女性"
  if (key === "male") return "男性"
  if (/^\d+$/.test(key) || key === String(index)) return `声 ${index + 1}`
  return key
}

/**
 * Voices available on disk: every `.onnx` model in `dir` whose sidecar config
 * exists, one entry per speaker. Sorted by model name, female speakers first.
 */
export async function scanPiperVoices(dir: string): Promise<PiperVoice[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const voices: PiperVoice[] = []
  for (const name of names.filter((n) => n.endsWith(".onnx")).sort()) {
    const model = join(dir, name)
    let config: VoiceConfig
    try {
      config = JSON.parse(await readFile(configPath(model), "utf8")) as VoiceConfig
    } catch {
      continue // a model without its config cannot be synthesized with
    }
    const stem = name.slice(0, -".onnx".length)
    const modelLabel = config.dataset ?? stem
    const entries: Array<[string, number]> = config.speaker_id_map
      ? Object.entries(config.speaker_id_map).sort((a, b) => a[1] - b[1])
      : Array.from({ length: Math.max(1, config.num_speakers ?? 1) }, (_, i) => [String(i), i])
    for (const [key, speaker] of entries) {
      voices.push({
        id: `${stem}#${speaker}`,
        label: `${speakerLabel(key, speaker)}（${modelLabel}）`,
        model,
        speaker,
      })
    }
  }
  return voices
}

/* -------------------------------------------------------------- text prep */

/**
 * Flattens sanitized text into a single utterance: piper reads one line as one
 * utterance, and paragraph breaks are worth less than a pause anyway.
 */
export function flattenUtterance(text: string): string {
  return text.replace(/\s*\n+\s*/g, " ").trim()
}

/**
 * Maps the UI's rate percent (-50..+50) to piper's `--length-scale`
 * (a duration multiplier: lower is faster).
 */
export function rateToLengthScale(rate: number): number {
  // The UI only ever sends -50..+50; anything wilder is clamped first so the
  // reciprocal can't invert (rates below -100% would flip the sign).
  const bounded = Math.max(-50, Math.min(100, Number.isFinite(rate) ? rate : 0))
  const scale = 1 / (1 + bounded / 100)
  return Math.min(2, Math.max(0.5, Number(scale.toFixed(3))))
}

/**
 * Maps the UI's rate percent (-50..+50) to VOICEVOX's `speedScale` (a speed
 * multiplier: higher is faster), the counterpart of `rateToLengthScale`.
 */
export function rateToSpeedScale(rate: number): number {
  const bounded = Math.max(-50, Math.min(100, Number.isFinite(rate) ? rate : 0))
  const scale = 1 + bounded / 100
  return Math.min(2, Math.max(0.5, Number(scale.toFixed(3))))
}

/* ---------------------------------------------------------------- synthesis */

export type SynthesizeOptions = {
  /** Aborts the synthesis; the child is killed and nothing resolves. */
  signal?: AbortSignal
  /** Seconds before a stuck synthesis is given up on. */
  timeoutSeconds?: number
}

/**
 * Runs one piper synthesis and returns the WAV bytes it produced.
 * Rejects with piper's last stderr line so the GUI can show something useful.
 *
 * The audio is requested through `--output_file`: without it the piper CLI
 * tries to play the result itself, which fails on a headless machine (it
 * warns about a missing ffplay and exits non-zero after dropping `output.wav`
 * into its working directory), and a plugin has no business grabbing the
 * audio device during synthesis anyway — the GUI plays everything.
 */
export function synthesizeWithPiper(
  bin: string,
  voice: PiperVoice,
  lengthScale: number,
  text: string,
  options: SynthesizeOptions = {},
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (!text) {
      reject(new Error("empty text"))
      return
    }
    const outPath = join(tmpdir(), `opencode-tts-${process.pid}-${Math.random().toString(36).slice(2)}.wav`)
    const args = [
      "-m",
      voice.model,
      "-s",
      String(voice.speaker),
      "--length-scale",
      String(lengthScale),
      "--sentence-silence",
      "0.4",
      "--output_file",
      outPath,
    ]
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let stderr = ""
    const limit = (options.timeoutSeconds ?? 180) * 1000
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("piper timed out"))
    }, limit)
    const abort = () => {
      child.kill("SIGKILL")
      reject(new Error("aborted"))
    }
    if (options.signal) {
      if (options.signal.aborted) {
        abort()
        return
      }
      options.signal.addEventListener("abort", abort, { once: true })
    }
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000)
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    const finish = async (code: number | null) => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      let audio = Buffer.alloc(0)
      if (code === 0) {
        try {
          audio = await readFile(outPath)
        } catch {
          audio = Buffer.concat(chunks) // older piper builds print the WAV to stdout
        }
      }
      void unlink(outPath).catch(() => {})
      if (audio.length > 44) {
        resolve(new Uint8Array(audio))
        return
      }
      // With --output_file piper may still print warnings to stderr; only
      // surface them when there is genuinely no audio to return.
      const detail = stderr.trim().split("\n").filter(Boolean).pop() ?? `exit ${code}`
      reject(new Error(detail))
    }
    child.on("close", (code) => void finish(code))
    child.stdin.write(text)
    child.stdin.write("\n")
    child.stdin.end()
  })
}

/* ----------------------------------------------------------------- sanitize */

/**
 * Turns a reply into something worth hearing: code is skipped, markup is
 * dropped, and the text is cut at a sentence when it runs long.
 */
export function sanitizeForSpeech(text: string): string {
  let out = text
  // Fenced code blocks, and the tables and rule lines that come with them.
  out = out.replace(/```[\s\S]*?```/g, " ")
  out = out.replace(/~~~[\s\S]*?~~~/g, " ")
  out = out.replace(/`([^`\n]*)`/g, " ")
  // Images carry no sound; links keep their words and lose the target.
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  out = out.replace(/https?:\/\/\S+/g, " ")
  // Markup that would be read out loud: heading markers, quotes, emphasis, rules.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "")
  out = out.replace(/^\s{0,3}>+\s?/gm, "")
  out = out.replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
  out = out.replace(/^\s*([-*_]\s*){3,}$/gm, "")
  out = out.replace(/\|/g, " ")
  out = out.replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, "$1")
  out = out.replace(/~~([^~\n]+)~~/g, "$1")
  out = out.replace(/<[^>\n]+>/g, " ")
  // Whitespace: one space where the layout was, one break where a paragraph was.
  out = out.replace(/[ \t]+/g, " ")
  out = out.replace(/ ?\n ?/g, "\n")
  out = out.replace(/\n{3,}/g, "\n\n")
  out = out.trim()

  if (out.length > MAX_SPEECH_CHARACTERS) {
    const cut = out.slice(0, MAX_SPEECH_CHARACTERS)
    const stop = Math.max(
      cut.lastIndexOf("。"),
      cut.lastIndexOf("．"),
      cut.lastIndexOf(". "),
      cut.lastIndexOf("!\n"),
      cut.lastIndexOf("?\n"),
      cut.lastIndexOf("\n"),
    )
    out = stop > MAX_SPEECH_CHARACTERS / 2 ? cut.slice(0, stop + 1) : cut
  }
  return out
}
