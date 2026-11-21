/**
 * TTS — RPC contract shared by the server and GUI halves.
 *
 * Plain JSON Schema literals: the server validates input and output with
 * them, and the GUI types its client proxy from the same definition.
 */
import type { Rpc } from "@opencode/schema/rpc"

const VOICE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "voice id: piper:<stem>#<n>[!child] | edge:<ShortName> | voicevox:<id>" },
    label: { type: "string" },
    engine: { type: "string", enum: ["piper", "voicevox", "edge"] },
    online: { type: "boolean" },
    gender: { type: "string", enum: ["male", "female", "unknown"] },
    child: { type: "boolean" },
    fx: { type: "boolean", description: "child variant produced by pitch shift, not a real child voice" },
    stem: { type: "string" },
    speaker: { type: "number" },
    speakerId: { type: "number" },
  },
  required: ["id", "label", "engine", "online", "gender", "child"],
} as const

const PREFS_PROPERTIES = {
  voice: { type: "string", description: "selected voice id (see catalog)" },
  rate: { type: "number" },
  autoPlay: { type: "boolean", description: "read new replies as they arrive" },
  keepWarm: { type: "boolean", description: "keep the local engine loaded in the background" },
  pickVoice: { type: "boolean", description: "ask which voice to read with when a read-aloud is requested" },
  fastStart: { type: "boolean", description: "stream from the resident engine so speech starts sooner" },
} as const

const PREFS_OUTPUT = {
  type: "object",
  properties: PREFS_PROPERTIES,
  required: ["voice", "rate", "autoPlay", "keepWarm", "pickVoice", "fastStart"],
} as const

export const TtsRpc = {
  id: "tts",
  methods: {
    // Synthesize speech for a message (or raw text) and return audio bytes:
    // WAV from a local engine (default), MP3 from the optional online one.
    // `voice` overrides the stored preference for this one request.
    speak: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
          text: { type: "string" },
          voice: { type: "string", description: "voice id from catalog; empty = stored preference" },
        },
      },
      output: {
        type: "object",
        properties: {
          audio: { type: "string", description: "base64-encoded audio (wav or mp3)" },
          mime: { type: "string" },
          text: { type: "string" },
          truncated: { type: "boolean" },
          messageID: { type: "string" },
          voice: { type: "string", description: "voice id actually used" },
          playbackRate: { type: "number", description: "play faster than normal (child voice); pitch rises with it" },
        },
        required: ["audio", "mime"],
      },
    },
    // Assistant replies in a session, oldest first.
    replies: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
      },
      output: {
        type: "object",
        properties: {
          replies: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                preview: { type: "string" },
              },
              required: ["id", "text", "preview"],
            },
          },
        },
        required: ["replies"],
      },
    },
    // Latest assistant reply in a session, if any.
    latest: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
      },
      output: {
        type: "object",
        properties: {
          reply: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              preview: { type: "string" },
            },
            required: ["id", "text", "preview"],
          },
        },
      },
    },
    // Every selectable voice across engines (local first, online last) and
    // which one is the fallback default. Scans the disk and probes optional
    // local engines; cheap enough to call whenever a picker opens.
    catalog: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          voices: { type: "array", items: VOICE_SCHEMA },
          defaultVoice: { type: "string" },
          note: { type: "string", description: "what the user should know (e.g. no local model found)" },
        },
        required: ["voices", "defaultVoice"],
      },
    },
    // Start (or reuse) the resident local engine and hand the webview what
    // it needs to stream synthesis directly, so the first sound arrives
    // before the whole text is synthesized. Same text resolution as `speak`;
    // an empty result means "no fast path — call speak".
    audioInfo: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
          text: { type: "string" },
          voice: { type: "string" },
        },
      },
      output: {
        type: "object",
        properties: {
          url: { type: "string", description: "loopback base URL, e.g. http://127.0.0.1:41234" },
          token: { type: "string" },
          voice: { type: "string", description: "voice id the plan is for" },
          playbackRate: { type: "number", description: "child-voice pitch pairing for playback" },
          synth: {
            type: "object",
            description: "ready-to-POST body for /synth; absent = warm-up only",
            properties: {
              text: { type: "string" },
              model: { type: "string" },
              speaker: { type: "number" },
              lengthScale: { type: "number" },
            },
            required: ["text", "model", "speaker", "lengthScale"],
          },
        },
      },
    },
    // User preferences.
    prefs: { input: { type: "object", properties: {} }, output: PREFS_OUTPUT },
    setPrefs: { input: { type: "object", properties: PREFS_PROPERTIES }, output: PREFS_OUTPUT },
  },
  events: {},
} satisfies Rpc.PortableDefinition

export type SpeakInput = { sessionID?: string; messageID?: string; text?: string; voice?: string }
export type SpeakResult = {
  audio: string
  mime: string
  text?: string
  truncated?: boolean
  messageID?: string
  voice?: string
  playbackRate?: number
}
export type ReplyItem = { id: string; text: string; preview: string }
/** Server-side catalog entry; `src/voices.ts` defines the full shape. */
export type CatalogVoice = {
  id: string
  label: string
  engine: "piper" | "voicevox" | "edge"
  online: boolean
  gender: "male" | "female" | "unknown"
  child: boolean
  fx?: boolean
  stem?: string
  speaker?: number
  speakerId?: number
}
export type CatalogResult = { voices: CatalogVoice[]; defaultVoice: string; note?: string }
/** Ready-to-POST body for the resident server's `/synth` endpoint. */
export type SynthPlan = { text: string; model: string; speaker: number; lengthScale: number }
/**
 * Fast-path info for the GUI: when `synth` is present the webview can stream
 * straight from the resident sidecar and start playing while the rest of the
 * phrase is still being synthesized; an empty result means "call speak".
 * `playbackRate` carries the child-voice pitch pairing.
 */
export type AudioInfoResult = {
  url?: string
  token?: string
  voice?: string
  playbackRate?: number
  synth?: SynthPlan
}
export type Prefs = {
  voice: string
  rate: number
  autoPlay: boolean
  keepWarm: boolean
  pickVoice: boolean
  fastStart: boolean
}
