import { describe, it, expect } from "vitest"
import {
  minutesFor,
  retentionDates,
  buildClipProps,
  normalizeSourceUrl,
  RAW_RETENTION_DAYS,
  ASSET_RETENTION_DAYS,
} from "./clip-pipeline"
import type { ClipSuggestion, TranscriptWord } from "./clip-types"

describe("minutesFor", () => {
  it("arredonda para o minuto cheio, mínimo 1", () => {
    expect(minutesFor(0)).toBe(1)
    expect(minutesFor(1)).toBe(1)
    expect(minutesFor(60)).toBe(1)
    expect(minutesFor(61)).toBe(2)
    expect(minutesFor(3000)).toBe(50) // 50min exatos
    expect(minutesFor(3001)).toBe(51)
  })
})

describe("normalizeSourceUrl", () => {
  it("Google Drive share → download direto", () => {
    expect(normalizeSourceUrl("https://drive.google.com/file/d/ABC123_-x/view?usp=sharing")).toBe(
      "https://drive.google.com/uc?export=download&id=ABC123_-x",
    )
    expect(normalizeSourceUrl("https://drive.google.com/open?id=XYZ789")).toBe(
      "https://drive.google.com/uc?export=download&id=XYZ789",
    )
  })
  it("Dropbox força dl=1", () => {
    expect(normalizeSourceUrl("https://www.dropbox.com/s/abc/video.mp4?dl=0")).toContain("dl=1")
  })
  it("YouTube e outras URLs ficam intactas", () => {
    const u = "https://youtu.be/abc123"
    expect(normalizeSourceUrl(u)).toBe(u)
  })
})

describe("retentionDates", () => {
  it("bruto em 7d, transcrição/clipes em 60d", () => {
    const now = new Date("2026-01-01T00:00:00.000Z")
    const { rawExpiresAt, expiresAt } = retentionDates(now)
    expect(rawExpiresAt).toBe(new Date(now.getTime() + RAW_RETENTION_DAYS * 86400_000).toISOString())
    expect(expiresAt).toBe(new Date(now.getTime() + ASSET_RETENTION_DAYS * 86400_000).toISOString())
  })
})

describe("buildClipProps", () => {
  const words: TranscriptWord[] = [
    { text: "a", startMs: 0, endMs: 500 },
    { text: "b", startMs: 12000, endMs: 12500 },
    { text: "c", startMs: 13000, endMs: 13500 },
    { text: "d", startMs: 46000, endMs: 46500 },
  ]
  const s: ClipSuggestion = {
    clip_id: "c1",
    title: "Título",
    hook_text: "Você está errando na retenção",
    source_quote: "você está errando",
    start_time: 12.4,
    end_time: 45.8,
    score: 94,
    rationale: "abertura forte",
    suggested_aspect_ratio: "9:16",
  }

  it("converte segundos→ms, mapeia aspecto e recorta+rebaseia as palavras", () => {
    const p = buildClipProps(s, words, "clips/raw/src.mp4")
    expect(p.inMs).toBe(12400)
    expect(p.outMs).toBe(45800)
    expect(p.aspect).toBe("9x16")
    expect(p.sourceKey).toBe("clips/raw/src.mp4")
    expect(p.brandOn).toBe(true)
    // só b e c caem na janela [12400,45800], re-baseados a 0
    expect(p.words).toEqual([
      { text: "b", startMs: 12000 - 12400 < 0 ? 0 : 12000 - 12400, endMs: 12500 - 12400 },
      { text: "c", startMs: 13000 - 12400, endMs: 13500 - 12400 },
    ])
    expect(p.openingCard?.words[0]).toBe("Você")
  })

  it("aspecto 16:9 mapeia para 16x9", () => {
    expect(buildClipProps({ ...s, suggested_aspect_ratio: "16:9" }, words, "k").aspect).toBe("16x9")
  })
})
