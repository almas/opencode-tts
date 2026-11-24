// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { synthesizeWithVoicevox } from "../src/voicevox"

/**
 * Fake VOICEVOX engine answering the three endpoints the plugin uses.
 * Records every request so the tests can assert which path was taken.
 */
const calls: { url: string; method: string; body?: string }[] = []
let supportAudioQuery = true

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
}

const server = {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    const body = typeof init?.body === "string" ? init.body : undefined
    calls.push({ url, method, body })
    if (url.includes("/audio_query")) {
      return supportAudioQuery ? jsonResponse({ speedScale: 1.0, pitchScale: 1.0 }) : new Response("not found", { status: 404 })
    }
    if (url.includes("/synthesis")) {
      const query = JSON.parse(body ?? "{}") as { speedScale?: number }
      return new Response(new Uint8Array([query.speedScale === 0.8 ? 1 : 0]))
    }
    if (url.includes("/speech_synthesis")) return new Response(new Uint8Array([2]))
    return new Response("not found", { status: 404 })
  },
}

beforeAll(() => {
  vi.stubGlobal("fetch", server.fetch)
})
afterEach(() => {
  calls.length = 0
  supportAudioQuery = true
})
afterAll(() => {
  vi.unstubAllGlobals()
})

describe("synthesizeWithVoicevox", () => {
  it("uses the plain one-shot endpoint when the speed is normal", async () => {
    const bytes = await synthesizeWithVoicevox(2, "こんにちは", { base: "http://engine.test" })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toContain("/speech_synthesis?")
    expect(calls[0].url).toContain("speaker=2")
    expect(calls[0].url).toContain(encodeURIComponent("こんにちは"))
    expect(bytes[0]).toBe(2)
  })

  it("routes through audio_query and applies speedScale for other speeds", async () => {
    const bytes = await synthesizeWithVoicevox(2, "ゆっくり", { speedScale: 0.8, base: "http://engine.test" })
    expect(calls.map((call) => (call.url.includes("/audio_query") ? "query" : "synth"))).toEqual(["query", "synth"])
    expect(calls[1].method).toBe("POST")
    expect(JSON.parse(calls[1].body ?? "{}").speedScale).toBe(0.8)
    expect(bytes[0]).toBe(1)
  })

  it("falls back to the one-shot endpoint when audio_query is missing", async () => {
    supportAudioQuery = false
    const bytes = await synthesizeWithVoicevox(2, "テスト", { speedScale: 1.3, base: "http://engine.test" })
    expect(calls.map((call) => call.url.includes("/audio_query"))).toEqual([true, false])
    expect(calls[1].url).toContain("/speech_synthesis")
    expect(bytes[0]).toBe(2)
  })
})
