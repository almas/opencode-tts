/**
 * VOICEVOX Engine — optional local, free, high-quality Japanese TTS.
 *
 * VOICEVOX is a separate desktop/CLI app many Japanese users already run; when
 * it is, it listens on loopback `:50021` and offers dozens of polished voices
 * with real child speakers. The plugin never installs or starts it: it probes,
 * and only lists those voices when the answer comes back. Everything here is
 * loopback HTTP, so nothing leaves the machine.
 */
import type { VoicevoxSpeaker } from "./voices"

/** Where VOICEVOX Engine listens by default. */
export const VOICEVOX_DEFAULT_URL = "http://127.0.0.1:50021"

/** Override the endpoint (e.g. a second engine instance on another port). */
export function voicevoxBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OC_TTS_VOICEVOX_URL?.trim() || VOICEVOX_DEFAULT_URL).replace(/\/+$/, "")
}

/** Cache probe results: the engine is either running or it is not. */
const PROBE_TTL_MS = 30_000
const PROBE_TIMEOUT_MS = 900

type CacheEntry = { at: number; speakers: VoicevoxSpeaker[] | null }
let cache: CacheEntry | null = null

interface RawSpeaker {
  id?: number
  name?: string
  isMale?: boolean
  isFemale?: boolean
  isChild?: boolean
  speaker_info?: { isMale?: boolean; isFemale?: boolean; isChild?: boolean }
}

/**
 * Speakers of a running engine, or null when no engine answers. Failures are
 * cached too — a user without VOICEVOX should pay one 900 ms probe per 30 s,
 * not one per dialog open.
 */
export async function probeVoicevox(
  base = voicevoxBaseUrl(),
  now: () => number = Date.now,
): Promise<VoicevoxSpeaker[] | null> {
  if (cache && now() - cache.at < PROBE_TTL_MS) return cache.speakers
  const speakers = await fetchSpeakers(base)
  cache = { at: now(), speakers }
  return speakers
}

/** Forget the cached probe (settings page rescan). */
export function resetVoicevoxProbe(): void {
  cache = null
}

async function fetchSpeakers(base: string): Promise<VoicevoxSpeaker[] | null> {
  try {
    const response = await fetch(`${base}/speakers`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!response.ok) return null
    const raw = (await response.json()) as RawSpeaker[]
    const speakers = raw.flatMap((entry) => {
      if (typeof entry.id !== "number" || !entry.name) return []
      const info = entry.speaker_info ?? {}
      const isMale = entry.isMale ?? info.isMale
      const isFemale = entry.isFemale ?? info.isFemale
      const isChild = entry.isChild ?? info.isChild
      return [
        {
          id: entry.id,
          name: entry.name,
          isMale: isMale ?? (isFemale === undefined ? undefined : !isFemale),
          isChild: isChild ?? false,
        } satisfies VoicevoxSpeaker,
      ]
    })
    return speakers.length ? speakers : null
  } catch {
    return null
  }
}

/**
 * Synthesize one utterance; returns WAV bytes. `speaker` is the style id the
 * catalog listed. Errors propagate — the caller falls back to another voice.
 */
export async function synthesizeWithVoicevox(
  speaker: number,
  text: string,
  base = voicevoxBaseUrl(),
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const query = new URLSearchParams({ speaker: String(speaker), text })
  const response = await fetch(`${base}/speech_synthesis?${query.toString()}`, {
    method: "POST",
    signal: signal ?? AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`voicevox replied ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}
