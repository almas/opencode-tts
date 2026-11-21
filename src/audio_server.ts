/**
 * Resident Piper process management.
 *
 * Spawning the piper CLI per phrase pays ~0.6 s of model load every time. For
 * read-aloud that delay is the whole perceived cost, so the plugin instead
 * keeps `assets/piper_server.py` alive (one Python process holding the models
 * in RAM) and talks to it over loopback HTTP. Synthesis of a short reply then
 * takes tens of milliseconds, and answers stream sentence by sentence so the
 * webview can start playing before the text is finished.
 *
 * The server is strictly optional: `synthesizeWithPiper` (CLI) stays as the
 * fallback, and everything here degrades to it when Python or the piper
 * package is missing.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Where this module lives — works from `src/` and from the bundled `dist/`. */
const moduleDir = dirname(fileURLToPath(import.meta.url))

/** The bundled Python sidecar. */
export const serverScriptPath = () => join(moduleDir, "..", "assets", "piper_server.py")

/** A running (or starting) audio server. */
export interface AudioServer {
  port: number
  token: string
  /** Model files currently loaded inside the server. */
  models: string[]
}

/** Synthesis request handed to the server. */
export interface ServerSynthRequest {
  model: string
  speaker?: number
  lengthScale?: number
  volume?: number
  text: string
}

const IDLE_SECONDS = 600
const START_TIMEOUT_MS = 20_000

let pythonBin: string | null | undefined
let proc: ReturnType<typeof spawn> | null = null
let server: AudioServer | null = null
let starting: Promise<AudioServer> | null = null
let sequence = 0

/** The interpreter that can `import piper`, or null when none is available. */
export function resolvePiperPython(): string | null {
  if (pythonBin !== undefined) return pythonBin
  const override = process.env.OC_TTS_PIPER_PYTHON?.trim()
  const candidates = [
    ...(override ? [override] : []),
    join(homedir(), ".local", "share", "uv", "tools", "piper-tts", "bin", "python"),
    "python3",
    "python",
  ]
  pythonBin = null
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ["-c", "import piper"], { timeout: 15_000, stdio: "ignore" })
      if (!probe.error && probe.status === 0) {
        pythonBin = candidate
        break
      }
    } catch {
      // Try the next candidate.
    }
  }
  return pythonBin
}

/** Whether the resident server is up and answering. */
export function audioServerAlive(): boolean {
  return !!server && !!proc && proc.exitCode === null && !proc.killed
}

/** The running server, or null (the common check before a fast-path synth). */
export function audioServer(): AudioServer | null {
  return audioServerAlive() ? server : null
}

/** Start the server (or return the running one). Rejects when piper is unavailable. */
export function ensureAudioServer(models: string[]): Promise<AudioServer> {
  if (audioServerAlive() && sameModels(server!.models, models)) return Promise.resolve(server!)
  if (starting) return starting
  if (server && !sameModels(server.models, models)) stopAudioServer()

  const python = resolvePiperPython()
  const script = serverScriptPath()
  if (!python || !existsSync(script)) return Promise.reject(new Error("resident piper server unavailable"))

  const token = `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  starting = new Promise<AudioServer>((resolve, reject) => {
    const child = spawn(
      python,
      [script, "--port", "0", "--token", token, "--idle", String(IDLE_SECONDS), "--models", models.join(",")],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    let buffer = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("piper server did not start within 20s"))
    }, START_TIMEOUT_MS)
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      const line = buffer.match(/READY (\{[^\n]*\})/)
      if (!line) return
      clearTimeout(timer)
      try {
        const info = JSON.parse(line[1] ?? "{}") as { port: number }
        server = { port: info.port, token, models: [...models] }
        proc = child
        console.info(`[tts] resident piper server on port ${info.port} (${models.length} model(s))`)
        resolve(server)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim()
      if (text) console.warn(`[tts] piper server: ${text.slice(0, 200)}`)
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("exit", () => {
      if (proc === child) proc = null
      if (!server || server.token !== token) {
        clearTimeout(timer)
        reject(new Error("piper server exited before ready"))
      } else if (server.token === token) {
        server = null
      }
    })
  }).finally(() => {
    starting = null
  })
  return starting
}

/** Ask the running server to keep models warm; cheap health probe. */
export async function audioServerPing(target: AudioServer): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${target.port}/health`, {
      headers: { "X-Tts-Token": target.token },
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Synthesize through the server and return a complete, size-correct WAV. */
export async function audioServerSynthesize(target: AudioServer, request: ServerSynthRequest): Promise<Uint8Array> {
  const response = await fetch(`http://127.0.0.1:${target.port}/synth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tts-Token": target.token },
    body: JSON.stringify(request),
  })
  if (!response.ok || !response.body) throw new Error(`piper server replied ${response.status}`)
  const audio = new Uint8Array(await response.arrayBuffer())
  return patchWavSizes(audio)
}

/** Information the webview needs to stream synthesis itself (first audio soonest). */
export interface AudioServerClientInfo {
  /** Base URL, e.g. `http://127.0.0.1:41234`. */
  url: string
  token: string
}

/** Details for GUI streaming; the GUI talks to the sidecar directly (loopback, tokened). */
export function audioServerClientInfo(target: AudioServer): AudioServerClientInfo {
  return { url: `http://127.0.0.1:${target.port}`, token: target.token }
}

/** Stop the server (plugin shutdown). */
export function stopAudioServer(): void {
  const child = proc
  server = null
  proc = null
  if (!child) return
  try {
    child.kill()
  } catch {
    // Already gone.
  }
}

function sameModels(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((value, index) => value === sortedB[index])
}

/**
 * The streamed WAV carries 0xFFFFFFFF placeholders (nobody knows the final
 * size up front); a complete buffer gets real sizes so any decoder accepts it.
 */
export function patchWavSizes(audio: Uint8Array): Uint8Array {
  if (audio.length < 44) return audio
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  if (view.getUint32(0, false) !== 0x52494646 /* RIFF */) return audio
  view.setUint32(4, audio.length - 8, true)
  // The `data` chunk is the last one in our stream.
  let offset = 12
  while (offset + 8 <= audio.length) {
    const size = view.getUint32(offset + 4, true)
    if (view.getUint32(offset, false) === 0x64617461 /* data */ && size === 0xffffffff) {
      view.setUint32(offset + 4, audio.length - offset - 8, true)
      break
    }
    if (size > audio.length) break
    offset += 8 + size
  }
  return audio
}
