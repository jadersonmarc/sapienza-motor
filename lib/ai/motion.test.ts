import { describe, it, expect } from "vitest"
import {
  statSourceInBrief,
  generateMotion,
  buildStory,
  MOTION_ASPECTS,
  type MotionBrief,
} from "./motion"
import type { SceneBlock, StoryProps } from "@/lib/content/motion-types"
import { fanoutAspects } from "@/lib/content/motion-types"
import { quantizeToBeat, beatSec, AUDIO_TRACKS } from "@/lib/content/motion-audio"

// Testes PUROS (sem IA/DB). Cobrem o guardrail do `stat` (número só do brief) e o
// fallback determinístico sem ANTHROPIC_API_KEY.

describe("motion — guardrail do stat (substring literal do brief)", () => {
  const brief: MotionBrief = {
    systemPrompt: "Nossa consultoria reduziu o tempo de resposta em 42% no último ano.",
    themes: ["atendimento", "eficiência operacional"],
  }

  it("aceita source que é substring do brief (case-insensitive)", () => {
    expect(statSourceInBrief("reduziu o tempo de resposta em 42%", brief)).toBe(true)
    expect(statSourceInBrief("REDUZIU O TEMPO DE RESPOSTA EM 42%", brief)).toBe(true)
  })

  it("rejeita source que não está no brief (número inventado)", () => {
    expect(statSourceInBrief("crescimento de 300% em vendas", brief)).toBe(false)
    expect(statSourceInBrief("", brief)).toBe(false)
  })

  it("rejeita quando o brief não tem número algum", () => {
    const semNumero: MotionBrief = { systemPrompt: "Ajudamos PMEs a atender melhor.", themes: ["atendimento"] }
    expect(statSourceInBrief("87% dos clientes", semNumero)).toBe(false)
  })
})

describe("motion — fallback sem IA", () => {
  it("gera um ROTEIRO válido (hook→desenvolvimento→CTA) e NUNCA usa stat", async () => {
    const c = await generateMotion("5 sinais de que sua PME precisa de um CRM")
    expect(c.preset).toBe("story")
    expect(c.props.kind).toBe("story")
    const story = c.props as StoryProps
    expect(story.scenes).toHaveLength(3)
    expect(story.scenes.map((s) => s.role)).toEqual(["hook", "develop", "cta"])
    expect(story.scenes.at(-1)!.block.kind).toBe("cta")
    expect(story.scenes.some((s) => s.block.kind === "stat")).toBe(false)
    expect(MOTION_ASPECTS).toContain(c.aspect)
    expect(c.title.length).toBeGreaterThan(0)
  })
})

describe("motion — buildStory (montagem do roteiro por arquétipo)", () => {
  const develop: SceneBlock = { kind: "slides", slides: [{ index: 0, title: "A" }, { index: 1, title: "B" }] }

  it("highlight: hook + desenvolvimento + CTA, mesmo sem hook/cta do modelo", () => {
    const s = buildStory("highlight", develop, {}, "atendimento no whatsapp")
    expect(s.scenes.map((x) => x.role)).toEqual(["hook", "develop", "cta"])
    expect(s.scenes[0].block.kind).toBe("headline") // hook derivado do tema
    expect(s.scenes[1].block).toEqual(develop)
    expect(s.scenes[2].block).toMatchObject({ kind: "cta", text: "Fale com a gente" }) // CTA padrão
    expect(s.theme).toBe("ink")
  })

  it("usa hook/cta/theme do modelo quando presentes", () => {
    const s = buildStory("highlight", develop, { hook: { words: ["Perca", "menos", "leads"] }, cta: { text: "Saiba mais" }, theme: "surface" }, "x")
    expect(s.scenes[0].block).toMatchObject({ kind: "headline", words: ["Perca", "menos", "leads"] })
    expect(s.scenes[2].block).toMatchObject({ kind: "cta", text: "Saiba mais" })
    expect(s.theme).toBe("surface")
    expect(s.scenes.every((x) => x.durSec > 0)).toBe(true)
  })

  it("list: uma cena statement numerada por item, entre hook e CTA", () => {
    const s = buildStory("list", develop, { list: { items: ["Capte o lead", "Responda na hora", "Feche a venda"] } }, "x")
    expect(s.scenes.map((x) => x.role)).toEqual(["hook", "develop", "develop", "develop", "cta"])
    const items = s.scenes.filter((x) => x.role === "develop")
    expect(items.every((x) => x.block.kind === "statement")).toBe(true)
    expect(items.map((x) => (x.block as { label?: string }).label)).toEqual(["01", "02", "03"])
    expect(s.scenes.at(-1)!.block.kind).toBe("cta")
  })

  it("myth_fact: dois statements rotulados Mito/Verdade", () => {
    const s = buildStory("myth_fact", develop, { mythFact: { myth: "IA substitui o time", fact: "IA devolve o tempo do time" } }, "x")
    const mid = s.scenes.filter((x) => x.role === "develop")
    expect(mid.map((x) => (x.block as { label?: string }).label)).toEqual(["Mito", "Verdade"])
    expect(mid.map((x) => (x.block as { text: string }).text)).toEqual(["IA substitui o time", "IA devolve o tempo do time"])
    expect(s.scenes.at(-1)!.block.kind).toBe("cta")
  })

  it("qa: a pergunta vira o hook e a resposta o desenvolvimento", () => {
    const s = buildStory("qa", develop, { qa: { question: "Vale a pena?", answer: "Sim, em semanas" } }, "x")
    expect(s.scenes[0].block).toMatchObject({ kind: "statement", label: "Pergunta", text: "Vale a pena?" })
    expect(s.scenes[1].block).toMatchObject({ kind: "statement", label: "Resposta", text: "Sim, em semanas" })
    expect(s.scenes.at(-1)!.block.kind).toBe("cta")
  })

  it("arquétipo sem conteúdo cai no desenvolvimento (reserva)", () => {
    const s = buildStory("myth_fact", develop, {}, "x") // sem mythFact
    expect(s.scenes.map((x) => x.role)).toEqual(["hook", "develop", "cta"])
    expect(s.scenes[1].block).toEqual(develop)
  })

  it("sem mood: audio 'none' e durações NÃO quantizadas", () => {
    const s = buildStory("highlight", develop, {}, "x")
    expect(s.audio).toBe("none")
    expect(s.scenes[0].durSec).toBe(1.6) // hook mantém a duração original
  })

  it("com mood: grava o audio e quantiza cada duração à grade de batidas do BPM", () => {
    const s = buildStory("highlight", develop, { audio: "upbeat" }, "x") // 120 bpm → batida 0.5s
    expect(s.audio).toBe("upbeat")
    const grid = beatSec(AUDIO_TRACKS.upbeat.bpm) // 0.5
    for (const sc of s.scenes) {
      const beats = sc.durSec / grid
      expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-9) // múltiplo exato de batida
      expect(sc.durSec).toBeGreaterThanOrEqual(grid)
    }
  })
})

describe("motion — fanoutAspects", () => {
  it("sempre inclui 9x16 + 1x1, com o principal 1º e sem duplicar", () => {
    expect(fanoutAspects("9x16")).toEqual(["9x16", "1x1"])
    expect(fanoutAspects("1x1")).toEqual(["1x1", "9x16"])
    expect(fanoutAspects("4x5")).toEqual(["4x5", "9x16", "1x1"])
  })
})

describe("motion-audio — quantizeToBeat", () => {
  it("encaixa segundos no múltiplo de batida mais próximo (mín. 1 batida)", () => {
    expect(quantizeToBeat(1.6, 120)).toBe(1.5) // 0.5s de batida → 3 batidas
    expect(quantizeToBeat(2.2, 120)).toBe(2.0) // 4 batidas
    expect(quantizeToBeat(0.1, 120)).toBe(0.5) // nunca menos que 1 batida
  })
})
