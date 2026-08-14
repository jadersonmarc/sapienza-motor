import { describe, it, expect } from "vitest"
import { sourceQuoteInTranscript, validateClips, sliceWords, applyWordCorrection, buildOverlays } from "./clip-analysis"
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

describe("applyWordCorrection", () => {
  const words = [
    { text: "A", startMs: 0, endMs: 1 },
    { text: "sapiensa", startMs: 1, endMs: 2 },
    { text: "é", startMs: 2, endMs: 3 },
    { text: "Sapiensa,", startMs: 3, endMs: 4 },
  ]
  it("corrige todas as ocorrências, case-insensitive, preservando pontuação", () => {
    const { words: out, count } = applyWordCorrection(words, "Sapiensa", "Sapienza")
    expect(count).toBe(2)
    expect(out[1].text).toBe("Sapienza")
    expect(out[3].text).toBe("Sapienza,") // vírgula preservada
    expect(out[0].text).toBe("A") // intactas
  })
  it("não muda nada quando não há match", () => {
    const { count } = applyWordCorrection(words, "xyz", "abc")
    expect(count).toBe(0)
  })
})

describe("buildOverlays", () => {
  const base: ClipSuggestion = {
    clip_id: "c",
    title: "T",
    hook_text: "H",
    source_quote: "abre com uma promessa clara",
    start_time: 0,
    end_time: 30,
    score: 90,
    rationale: "R",
    suggested_aspect_ratio: "9:16",
  }
  it("gera overlay de citação quando o source_quote é curto", () => {
    const ov = buildOverlays(base, [])
    expect(ov.some((o) => o.kind === "quote")).toBe(true)
  })
  it("não gera citação quando o trecho é longo", () => {
    const long = { ...base, source_quote: "uma ".repeat(20).trim() }
    expect(buildOverlays(long, []).some((o) => o.kind === "quote")).toBe(false)
  })
  it("gera card de dado do 1º número, com source literal do trecho", () => {
    const words = [
      { text: "retenção", startMs: 0, endMs: 500 },
      { text: "sobe", startMs: 500, endMs: 900 },
      { text: "40%", startMs: 900, endMs: 1300 },
      { text: "assim", startMs: 1300, endMs: 1700 },
    ]
    const ov = buildOverlays({ ...base, source_quote: "x ".repeat(20).trim() }, words)
    const stat = ov.find((o) => o.kind === "stat")
    expect(stat).toBeDefined()
    if (stat && stat.kind === "stat") {
      expect(stat.value).toBe(40)
      expect(stat.suffix).toBe("%")
      expect(stat.source).toContain("40%") // literal do trecho (guardrail por construção)
    }
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
