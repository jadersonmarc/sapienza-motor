import { describe, it, expect } from "vitest"
import { sourceQuoteInTranscript, validateClips, sliceWords } from "./clip-analysis"
import type { ClipSuggestion, TranscriptWord } from "@/lib/content/clip-types"

const TRANSCRIPT = "Você está errando na retenção. O segredo é abrir com uma promessa clara e entregar em trinta segundos."

function clip(over: Partial<ClipSuggestion>): Partial<ClipSuggestion> {
  return {
    clip_id: "c1",
    title: "T",
    hook_text: "H",
    source_quote: "você está errando na retenção",
    start_time: 0,
    end_time: 30,
    score: 90,
    rationale: "R",
    suggested_aspect_ratio: "9:16",
    ...over,
  }
}

describe("guardrail source_quote", () => {
  it("aceita substring literal (case-insensitive)", () => {
    expect(sourceQuoteInTranscript("VOCÊ está errando na retenção", TRANSCRIPT)).toBe(true)
  })
  it("rejeita frase que a IA inventou", () => {
    expect(sourceQuoteInTranscript("o segredo é postar todo dia", TRANSCRIPT)).toBe(false)
  })
  it("rejeita vazio", () => {
    expect(sourceQuoteInTranscript("   ", TRANSCRIPT)).toBe(false)
  })
})

describe("validateClips", () => {
  it("descarta corte cujo source_quote não é literal", () => {
    const out = validateClips({ clips: [clip({ source_quote: "frase inexistente" })] }, TRANSCRIPT)
    expect(out).toHaveLength(0)
  })
  it("descarta janela inválida (end <= start) e acima do teto de duração", () => {
    const bad = [clip({ end_time: 0 }), clip({ start_time: 0, end_time: 999 })]
    expect(validateClips({ clips: bad }, TRANSCRIPT, { maxDurationSec: 300 })).toHaveLength(0)
  })
  it("ordena por score desc e normaliza (clamp + aspecto)", () => {
    const out = validateClips(
      {
        clips: [
          clip({ clip_id: "a", score: 40, suggested_aspect_ratio: "16:9" }),
          clip({ clip_id: "b", score: 150 }),
        ],
      },
      TRANSCRIPT,
    )
    expect(out.map((c) => c.clip_id)).toEqual(["b", "a"])
    expect(out[0].score).toBe(100) // clamp
    expect(out[1].suggested_aspect_ratio).toBe("16:9")
  })
})

describe("sliceWords", () => {
  const words: TranscriptWord[] = [
    { text: "a", startMs: 0, endMs: 500 },
    { text: "b", startMs: 500, endMs: 1000 },
    { text: "c", startMs: 1000, endMs: 1500 },
    { text: "d", startMs: 1500, endMs: 2000 },
  ]
  it("recorta o trecho e re-baseia a 0 = início do clipe", () => {
    const out = sliceWords(words, 500, 1500)
    expect(out).toEqual([
      { text: "b", startMs: 0, endMs: 500 },
      { text: "c", startMs: 500, endMs: 1000 },
    ])
  })
})
