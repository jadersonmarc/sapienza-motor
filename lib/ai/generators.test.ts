import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { getSocialGenerator, SOCIAL_PLATFORMS, generateSocial, isSocialPlatform } from "./social"
import {
  ANALYZER_LIST,
  getAnalyzer,
  isAnalysisType,
  runAnalyzer,
  AiNotConfiguredError,
} from "./analyzers"
import { generateDraft } from "./generate"

// Testa as partes puras (prompt builders, listas, validação) e o caminho de
// fallback (sem ANTHROPIC_API_KEY). O caminho com IA é seam (não testado aqui).

const input = {
  title: "5 sinais de que sua PME precisa de um CRM",
  bodyMarkdown: "## Intro\nCorpo do artigo.",
  excerpt: "Sinais de que chegou a hora do CRM.",
  pilar: "pme" as string | null,
  url: "https://exemplo.com/post",
}

describe("social generators", () => {
  it("SOCIAL_PLATFORMS lista instagram e linkedin", () => {
    expect(SOCIAL_PLATFORMS.map((p) => p.platform).sort()).toEqual(["instagram", "linkedin"])
  })
  it("isSocialPlatform valida", () => {
    expect(isSocialPlatform("instagram")).toBe(true)
    expect(isSocialPlatform("tiktok")).toBe(false)
  })
  it("buildUser inclui o artigo e as instruções da plataforma", () => {
    const ig = getSocialGenerator("instagram")!
    const u = ig.buildUser(input)
    expect(u).toContain(input.title)
    expect(u).toMatch(/hashtags/i)
    expect(u).toContain(input.url)
  })
  it("fallback (sem IA): body = excerpt + link, sem hashtags", async () => {
    const r = await generateSocial("linkedin", input)
    expect(r.model).toBeNull()
    expect(r.body).toContain(input.excerpt)
    expect(r.body).toContain(input.url)
    expect(r.hashtags).toEqual([])
  })
})

describe("analyzers", () => {
  it("ANALYZER_LIST tem os 4 tipos", () => {
    expect(ANALYZER_LIST.map((a) => a.type).sort()).toEqual(["emotional", "quality", "seo", "thematic"])
  })
  it("isAnalysisType valida", () => {
    expect(isAnalysisType("seo")).toBe(true)
    expect(isAnalysisType("vibe")).toBe(false)
  })
  it("buildUser inclui título e corpo", () => {
    const u = getAnalyzer("quality")!.buildUser({ ...input, keywords: ["crm", "pme"] })
    expect(u).toContain(input.title)
    expect(u).toContain("Corpo do artigo.")
    expect(u).toContain("crm, pme")
  })
  it("sem IA, runAnalyzer lança AiNotConfiguredError", async () => {
    await expect(runAnalyzer("seo", input)).rejects.toBeInstanceOf(AiNotConfiguredError)
  })
})

describe("generateDraft fallback", () => {
  it("sem IA gera rascunho determinístico com keywords vazias", async () => {
    const d = await generateDraft("meu tema de teste")
    expect(d.title).toContain("meu tema")
    expect(d.slug).toContain("meu-tema")
    expect(d.keywords).toEqual([])
  })
})
