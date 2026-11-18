/**
 * edge-tts: text-to-speech over the Microsoft Edge "Read Aloud" service, the
 * same voices the Read Aloud browser extension uses.
 *
 * Implemented against the service protocol directly (a WebSocket session with
 * a speech.config frame and an SSML frame, MP3 back) so the plugin needs no
 * extra runtime and no Python. The `Sec-MS-GEC` request token follows the v2
 * format ("<CS64>-<SHA-256>" over Edge's copyright line plus the Windows file
 * time), worked out in edge-tts PR #492; the checksum here is a port of that
 * algorithm (msedge-tts, MIT).
 */

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
const WSS_BASE = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
const VOICES_URL =
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=" +
  TRUSTED_CLIENT_TOKEN
const CHROMIUM_VERSION = "143.0.3650.96"
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_VERSION}`
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3"
/* The service turns the handshake away without browser-like headers. */
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
const EDGE_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
const SOCKET_HEADERS = { "User-Agent": EDGE_UA, Origin: EDGE_ORIGIN } as const

/** Clock skew against the service, corrected from its `Date` header after a refusal. */
let clockOffsetMs = 0

/** The longest text the service takes in one SSML frame. */
const MAX_CHUNK_BYTES = 4096

/**
 * The longest reply to read in one go. Anything longer is cut at a sentence
 * boundary; a reply that runs on forever is not something to listen to.
 */
export const MAX_SPEECH_CHARACTERS = 6000

/* ---------------------------------------------------------------- DRM token */

const EDGE_COPYRIGHT = "Copyright (C) Microsoft Corporation. All rights reserved."
const WIN_EPOCH_SECONDS = 11644473600

const SWAP_FIRST = { word: 0xef0569fb, sum: 0x76f50f34, product: 0xc3efea97 }
const SWAP_SECOND = { word: 0xc31713db, sum: 0x1881ce3c, product: 0x35bd1ec9 }
const MIX_FIRST = [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]
const MIX_SECOND = [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69]

function swapHalves(value: number): number {
  return ((value << 16) | (value >>> 16)) >>> 0
}

function swapTerm(word: number, key: number, m: typeof SWAP_FIRST): number {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), m.word)
  const product = Math.imul(swapHalves(sum), m.sum) >>> 0
  return (Math.imul(swapHalves(product), m.product) + product) >>> 0
}

function mixValue(value: number, multipliers: readonly number[]): number {
  let result = value
  for (const multiplier of multipliers) result = Math.imul(swapHalves(result), multiplier) >>> 0
  return result
}

/** The CS64 checksum over the message, keyed by the SHA-256 digest. */
function cs64(message: Uint8Array, digest: Uint8Array): string {
  const keys = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
  const firstKey = (keys.getUint32(0, true) | 1) >>> 0
  const secondKey = (keys.getUint32(4, true) | 1) >>> 0

  // The message, read as little-endian 32-bit word pairs, zero padded to a whole pair.
  const padded = new Uint8Array(Math.ceil(message.length / 8) * 8)
  padded.set(message)
  const words = new DataView(padded.buffer)

  let swapSum = 0
  let lastSwap = 0
  let mix = 0
  let mixSum = 0
  for (let offset = 0; offset < padded.length; offset += 8) {
    const first = words.getUint32(offset, true)
    const second = words.getUint32(offset + 4, true)
    lastSwap = swapTerm(second, secondKey, SWAP_SECOND)
    swapSum = (swapSum + swapTerm(first, firstKey, SWAP_FIRST) + lastSwap) >>> 0
    mix = mixValue(Math.imul(mix + first, firstKey), MIX_FIRST)
    mixSum = (mixSum + mix) >>> 0
    mix = mixValue(Math.imul(mix + second, secondKey), MIX_SECOND)
    mixSum = (mixSum + mix) >>> 0
  }

  const checksum = new DataView(new ArrayBuffer(8))
  checksum.setUint32(0, (lastSwap ^ mix) >>> 0, true)
  checksum.setUint32(4, (swapSum ^ mixSum) >>> 0, true)
  return hex(new Uint8Array(checksum.buffer))
}

const upperHex = (value: number) => value.toString(16).padStart(2, "0").toUpperCase()
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, upperHex).join("")
}

/**
 * The `Sec-MS-GEC` token for the current time: CS64 and SHA-256 over Edge's
 * copyright line followed by the Windows file time (100 ns ticks, floored to
 * five minutes) and the trusted client token.
 */
async function secMsGec(now: number = Date.now()): Promise<string> {
  const seconds = Math.floor((now + clockOffsetMs) / 1000) + WIN_EPOCH_SECONDS
  // Kept as a float like the browser's own clock maths: the product rounds
  // beyond 2^53, and the service expects that same rounded value.
  const filetime = (seconds - (seconds % 300)) * 10000000
  const message = new TextEncoder().encode(`${EDGE_COPYRIGHT}${filetime}${TRUSTED_CLIENT_TOKEN}`)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", message))
  return `${cs64(message, digest)}-${hex(digest)}`
}

/* -------------------------------------------------------------- text layout */

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

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

/** Splits escaped text into frames of at most `maxBytes`, never mid-character. */
function splitBytes(text: string, maxBytes: number): string[] {
  const encoder = new TextEncoder()
  const chunks: string[] = []
  let rest = text
  while (encoder.encode(rest).length > maxBytes) {
    let cut = rest.length
    while (encoder.encode(rest.slice(0, cut)).length > maxBytes) {
      cut = Math.floor((cut * maxBytes) / encoder.encode(rest.slice(0, cut)).length)
    }
    // Prefer a break at a sentence or a space, and never inside an XML entity.
    const head = rest.slice(0, cut)
    const at = Math.max(head.lastIndexOf("。"), head.lastIndexOf(" "), head.lastIndexOf("\n"))
    if (at > 0) cut = at + 1
    const amp = head.lastIndexOf("&", cut)
    if (amp >= 0 && head.slice(amp, cut).indexOf(";") < 0) cut = amp
    if (cut <= 0) cut = 1
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim()) chunks.push(rest)
  return chunks
}

/* ---------------------------------------------------------------- synthesis */

type SynthesizeOptions = {
  /** Aborts the synthesis; the WebSocket is closed and nothing resolves. */
  signal?: AbortSignal
  /** Called with the fraction (0..1) of the text whose audio has arrived. */
  progress?: (done: number) => void
}

/** One SSML frame's worth of speech, as the service takes it. */
function ssml(voice: string, rate: string, escaped: string): string {
  const speed = rate && rate !== "0%" ? rate : "+0%"
  return (
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="ja-JP">' +
    `<voice name="${voice}">` +
    `<prosody pitch="+0Hz" rate="${speed}" volume="+0%">${escaped}</prosody>` +
    "</voice>" +
    "</speak>"
  )
}

/**
 * The SSML request. The frame is kept byte-for-byte like the one Edge itself
 * sends: only the request id (a UUID without dashes), the content type and
 * the path. Extra headers make the service answer with an empty turn.
 */
function requestFrame(requestId: string, body: string): string {
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${body}`
}

function speechConfigFrame(): string {
  return (
    "Content-Type:application/json; charset=utf-8\r\n" +
    "Path:speech.config\r\n\r\n" +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}`
  )
}

function parseHeaderLines(text: string): Map<string, string> {
  const headers = new Map<string, string>()
  for (const line of text.split("\r\n")) {
    const at = line.indexOf(":")
    if (at > 0) headers.set(line.slice(0, at), line.slice(at + 1))
  }
  return headers
}

/**
 * One service message. Text frames are headers, a blank line and a body.
 * Audio frames put a two byte header length in front and start the MP3 right
 * after `Path:audio`, with no delimiter; protocol errors arrive as headerless
 * binary frames holding a JSON `{"error": {...}` document.
 */
type ServiceFrame =
  | { kind: "audio"; body: Uint8Array }
  | { kind: "turn-end" }
  | { kind: "response"; headers: Map<string, string>; body: Uint8Array }
  | { kind: "error"; message: string }
  | { kind: "ignore" }

const frameDecoder = new TextDecoder("utf-8", { fatal: false })
const AUDIO_MARKER = new TextEncoder().encode("Path:audio\r\n")

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

function parseFrame(data: ArrayBuffer | string): ServiceFrame {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)
  const head = frameDecoder.decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
  const path = /Path:([^\r\n]*)/.exec(head)?.[1]
  if (path === "audio" && typeof data !== "string") {
    const at = indexOfBytes(bytes, AUDIO_MARKER, 0)
    if (at < 0) return { kind: "ignore" }
    return { kind: "audio", body: bytes.subarray(at + AUDIO_MARKER.length) }
  }
  if (path === "turn.end") return { kind: "turn-end" }
  if (path === "response") {
    let delimiter = -1
    for (let i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
        delimiter = i
        break
      }
    }
    if (delimiter < 0) return { kind: "response", headers: parseHeaderLines(head), body: new Uint8Array(0) }
    return {
      kind: "response",
      headers: parseHeaderLines(frameDecoder.decode(bytes.subarray(0, delimiter))),
      body: bytes.subarray(delimiter + 4),
    }
  }
  if (!path && (head.includes('{"error"') || head.includes("HHG"))) {
    const at = head.indexOf("{")
    return { kind: "error", message: at < 0 ? head.trim() : head.slice(at).replace(/\u0000+$/, "") }
  }
  return { kind: "ignore" }
}

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "")
}

/** Open the service socket; the handshake is refused without browser headers. */
function openSocket(url: string): WebSocket {
  try {
    // Bun and recent Node accept extra request headers here; older runtimes do not.
    return new WebSocket(url, { headers: SOCKET_HEADERS } as never)
  } catch {
    return new WebSocket(url)
  }
}

/** Reads one chunk of text aloud and collects its MP3. */
async function synthesizeChunk(chunk: string, voice: string, rate: string, options: SynthesizeOptions): Promise<Uint8Array> {
  const url = await socketUrl()
  return new Promise<Uint8Array>((resolve, reject) => {
    const audio: Uint8Array[] = []
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {}
      reject(error)
    }
    const succeed = () => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {}
      const total = audio.reduce((sum, part) => sum + part.length, 0)
      const merged = new Uint8Array(total)
      let at = 0
      for (const part of audio) {
        merged.set(part, at)
        at += part.length
      }
      resolve(merged)
    }

    const socket = openSocket(url)
    socket.binaryType = "arraybuffer"
    const timer = setTimeout(() => fail(new Error("edge-tts: no answer from the service")), 30_000)
    const abort = () => fail(new Error("edge-tts: cancelled"))
    options.signal?.addEventListener("abort", abort)
    const done = (error?: unknown) => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      if (error) fail(error instanceof Error ? error : new Error(String(error)))
    }

    socket.addEventListener("open", () => {
      socket.send(speechConfigFrame())
      socket.send(requestFrame(uuid(), ssml(voice, rate, escapeXml(chunk))))
    })
    socket.addEventListener("error", () => done(new Error("edge-tts: the connection to the service failed")))
    socket.addEventListener("close", () => done(new Error("edge-tts: the service closed the connection")))
    socket.addEventListener("message", (event: MessageEvent) => {
      try {
        const frame = parseFrame(event.data as ArrayBuffer | string)
        if (frame.kind === "audio") {
          if (frame.body.length > 0) audio.push(frame.body)
        } else if (frame.kind === "turn-end") {
          done()
          if (audio.length === 0) fail(new Error("edge-tts: the service sent no audio"))
          else succeed()
        } else if (frame.kind === "response") {
          const error = frame.headers.get("X-ErrType")
          if (error) done(new Error(`edge-tts: ${error}: ${frame.headers.get("X-Fatal") || frameDecoder.decode(frame.body)}`))
        } else if (frame.kind === "error") {
          done(new Error(`edge-tts: ${frame.message.slice(0, 200)}`))
        }
      } catch (error) {
        done(error)
      }
    })
  })
}

async function socketUrl(): Promise<string> {
  const token = await secMsGec()
  return (
    `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${encodeURIComponent(token)}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${uuid()}`
  )
}

/** Measure our clock's skew against the service, using its own `Date` header. */
async function syncClock(): Promise<void> {
  try {
    const response = await fetch(VOICES_URL, { method: "HEAD" })
    const date = response.headers.get("date")
    if (date) {
      const serverTime = Date.parse(date)
      if (Number.isFinite(serverTime)) clockOffsetMs = serverTime - Date.now()
    }
  } catch {
    // No header to learn from; the retry will use the local clock.
  }
}

/**
 * Reads `text` aloud with `voice` at `rate` and returns MP3 audio.
 *
 * A reply longer than one frame is read as several service calls, and their
 * audio is concatenated: the stream is 48 kbps CBR MP3, so the pieces play as
 * one. A request that the service rejects as a clock problem is retried once.
 */
export async function synthesize(
  text: string,
  voice: string,
  rate: string,
  options: SynthesizeOptions = {},
): Promise<Uint8Array> {
  const plain = sanitizeForSpeech(text)
  if (!plain.trim()) throw new Error("edge-tts: nothing to read")
  const chunks = splitBytes(escapeXml(plain), MAX_CHUNK_BYTES)
  const parts: Uint8Array[] = []
  for (const [index, chunk] of chunks.entries()) {
    const unescaped = chunk.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    try {
      parts.push(await synthesizeChunk(unescaped, voice, rate, options))
    } catch (error) {
      if (options.signal?.aborted) throw error
      // One retry. The token is tied to the clock, and a refusal is often just
      // clock skew, so measure it from the service before trying again.
      await syncClock()
      parts.push(await synthesizeChunk(unescaped, voice, rate, options))
    }
    options.progress?.((index + 1) / chunks.length)
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const audio = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    audio.set(part, at)
    at += part.length
  }
  return audio
}
