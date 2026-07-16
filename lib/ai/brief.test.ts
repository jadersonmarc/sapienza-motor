import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildBriefUser, generateFromBrief } from "./brief"

const here = dirname(fileURLToPath(import.meta.url))
const importsOf = (file: string) =>
  readFileSync(join(here, file), "utf8")
    .split("\n")
    .filter((l) => /^\s*import\b/.test(l))
    .join("\n")

describe("buildBriefUser", () => {
  it("inclui objetivo e omite campos vazios", () => {
    const u = buildBriefUser({ objetivo: "Vender o plano X" })
    expect(u).toContain("OBJETIVO / EXPECTATIVA: Vender o plano X")
    expect(u).not.toContain("PONTOS-CHAVE:")
    expect(u).not.toContain("PÚBLICO:")
  })
  it("inclui pontos-chave, público, pilar e tom quando informados", () => {
    const u = buildBriefUser({
      objetivo: "obj",
      pontosChave: "ponto A",
      publico: "advogados",
      pilar: "pme",
      tom: "direto",
    })
    expect(u).toContain("PONTOS-CHAVE:")
    expect(u).toContain("ponto A")
    expect(u).toContain("PÚBLICO: advogados")
    expect(u).toContain("PILAR: pme")
    expect(u).toContain("TOM: direto")
  })
})

describe("generateFromBrief fallback (sem IA)", () => {
  it("gera rascunho determinístico a partir do objetivo", async () => {
    const d = await generateFromBrief({ objetivo: "meu objetivo de teste" })
    expect(d.model).toBeNull()
    expect(d.title).toContain("meu objetivo")
    expect(d.slug).toContain("meu-objetivo")
    expect(d.keywords).toEqual([])
  })
})

// Não-regressão (crítico, espelha spa-sapienza): o brief é um produtor SEPARADO —
// não importa o gerador do cron (generate) e vice-versa. Ambos só compartilham o client.
describe("isolamento do produtor por brief", () => {
  it("brief não importa o gerador do cron (generate)", () => {
    expect(importsOf("brief.ts")).not.toMatch(/\.\/generate/)
  })
  it("o gerador do cron não importa o brief", () => {
    expect(importsOf("generate.ts")).not.toMatch(/\.\/brief/)
  })
})
