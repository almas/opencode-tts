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
    // Synthesize speech for a message (or raw text) and return mp3 bytes.
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
          audio: { type: "string", description: "base64-encoded mp3" },
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
    // Available voices (server-side source of truth for the settings UI).
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
        },
        required: ["voice", "rate", "autoPlay"],
      },
    },
    setPrefs: {
      input: {
        type: "object",
        properties: {
          voice: { type: "string" },
          rate: { type: "number" },
          autoPlay: { type: "boolean" },
        },
      },
      output: {
        type: "object",
        properties: {
          voice: { type: "string" },
          rate: { type: "number" },
          autoPlay: { type: "boolean" },
        },
        required: ["voice", "rate", "autoPlay"],
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
export type Prefs = { voice: string; rate: number; autoPlay: boolean }
