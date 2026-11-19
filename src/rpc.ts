/**
 * TTS — RPC contract shared by the server and GUI halves.
 *
 * Plain JSON Schema literals: the server validates input and output with
 * them, and the GUI types its client proxy from the same definition.
 */
import type { Rpc } from "@opencode/schema/rpc"

export const TtsRpc = {
  id: "tts",
  methods: {
    // Synthesize speech for a message (or raw text) locally and return wav bytes.
    speak: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
          text: { type: "string" },
        },
      },
      output: {
        type: "object",
        properties: {
          audio: { type: "string", description: "base64-encoded wav" },
          mime: { type: "string" },
          text: { type: "string" },
          truncated: { type: "boolean" },
          messageID: { type: "string" },
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
    // Voices installed on disk, plus an explanatory note when there are none.
    voices: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          voices: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
              },
              required: ["id", "label"],
            },
          },
          note: { type: "string" },
        },
        required: ["voices"],
      },
    },
    // User preferences.
    prefs: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          voice: { type: "string" },
          rate: { type: "number" },
          autoPlay: { type: "boolean" },
          keepWarm: { type: "boolean" },
        },
        required: ["voice", "rate", "autoPlay", "keepWarm"],
      },
    },
    setPrefs: {
      input: {
        type: "object",
        properties: {
          voice: { type: "string" },
          rate: { type: "number" },
          autoPlay: { type: "boolean" },
          keepWarm: { type: "boolean" },
        },
      },
      output: {
        type: "object",
        properties: {
          voice: { type: "string" },
          rate: { type: "number" },
          autoPlay: { type: "boolean" },
          keepWarm: { type: "boolean" },
        },
        required: ["voice", "rate", "autoPlay", "keepWarm"],
      },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition

export type SpeakInput = { sessionID?: string; messageID?: string; text?: string }
export type SpeakResult = {
  audio: string
  mime: string
  text?: string
  truncated?: boolean
  messageID?: string
}
export type ReplyItem = { id: string; text: string; preview: string }
export type VoiceItem = { id: string; label: string }
export type Prefs = { voice: string; rate: number; autoPlay: boolean; keepWarm: boolean }
