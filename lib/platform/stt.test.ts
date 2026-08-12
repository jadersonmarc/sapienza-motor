import { describe, it, expect, vi, afterEach } from "vitest"
import { HttpStt, NoopStt, sttFromEnv, SttNotConfiguredError } from "./stt"

afterEach(() => vi.unstubAllGlobals())

describe("stt (espelho TS)", () => {
  it("Noop: sem provedor configurado, transcribe lança", async () => {
    const p = new NoopStt()
    expect(p.configured()).toBe(false)
    await expect(p.transcribe(Buffer.from("x"), "audio/mp3")).rejects.toBeInstanceOf(SttNotConfiguredError)
  })

  it("sttFromEnv sem STT_API_KEY → Noop", () => {
    const prev = process.env.STT_API_KEY
    delete process.env.STT_API_KEY
    expect(sttFromEnv().configured()).toBe(false)
    if (prev) process.env.STT_API_KEY = prev
  })

  it("texto puro: não pede verbose_json e não traz palavras", async () => {
    let sentFormat: FormDataEntryValue | null = null
    let sentModel: FormDataEntryValue | null = null
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: FormData }) => {
        sentFormat = init.body.get("response_format")
        sentModel = init.body.get("model")
        return new Response(JSON.stringify({ text: "olá mundo" }), { status: 200 })
      }),
    )
    const p = new HttpStt("https://x/v1", "sk", "whisper-large-v3-turbo")
    const res = await p.transcribe(Buffer.from("A"), "audio/mp3")
    expect(res.text).toBe("olá mundo")
    expect(res.words).toHaveLength(0)
    expect(sentModel).toBe("whisper-large-v3-turbo")
    expect(sentFormat).toBeNull()
  })

  it("wordTimestamps: pede verbose_json+word e mapeia segundos→ms", async () => {
    let format: FormDataEntryValue | null = null
    let gran: FormDataEntryValue | null = null
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: FormData }) => {
        format = init.body.get("response_format")
        gran = init.body.get("timestamp_granularities[]")
        return new Response(
          JSON.stringify({
            text: "olá mundo",
            language: "portuguese",
            words: [
              { word: "olá", start: 0.0, end: 0.5 },
              { word: "mundo", start: 0.5, end: 1.25 },
            ],
          }),
          { status: 200 },
        )
      }),
    )
    const p = new HttpStt("https://x/v1", "sk", "whisper-large-v3-turbo")
    const res = await p.transcribe(Buffer.from("A"), "audio/mp4", { wordTimestamps: true, language: "pt" })
    expect(format).toBe("verbose_json")
    expect(gran).toBe("word")
    expect(res.lang).toBe("portuguese")
    expect(res.words).toEqual([
      { text: "olá", startMs: 0, endMs: 500 },
      { text: "mundo", startMs: 500, endMs: 1250 },
    ])
  })

  it("propaga erro de status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })))
    const p = new HttpStt("https://x/v1", "sk-bad", "whisper-1")
    await expect(p.transcribe(Buffer.from("x"), "audio/mp3")).rejects.toThrow(/401/)
  })
})
