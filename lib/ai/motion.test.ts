import { describe, it, expect } from "vitest"
import {
  statSourceInBrief,
  generateMotion,
  buildStory,
  MOTION_ASPECTS,
  type MotionBrief,
} from "./motion"
import type { SceneBlock, StoryProps } from "@/lib/content/motion-types"

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

describe("motion — buildStory (montagem do roteiro)", () => {
  const develop: SceneBlock = { kind: "slides", slides: [{ index: 0, title: "A" }, { index: 1, title: "B" }] }

  it("sempre entrega hook + desenvolvimento + CTA, mesmo sem hook/cta do modelo", () => {
    const s = buildStory(develop, {}, "atendimento no whatsapp")
    expect(s.scenes.map((x) => x.role)).toEqual(["hook", "develop", "cta"])
    expect(s.scenes[0].block.kind).toBe("headline") // hook derivado do tema
    expect(s.scenes[1].block).toEqual(develop)
    expect(s.scenes[2].block).toMatchObject({ kind: "cta", text: "Fale com a gente" }) // CTA padrão
    expect(s.theme).toBe("ink") // default
  })

  it("usa hook/cta/theme do modelo quando presentes", () => {
    const s = buildStory(develop, { hook: { words: ["Perca", "menos", "leads"] }, cta: { text: "Saiba mais" }, theme: "surface" }, "x")
    expect(s.scenes[0].block).toMatchObject({ kind: "headline", words: ["Perca", "menos", "leads"] })
    expect(s.scenes[2].block).toMatchObject({ kind: "cta", text: "Saiba mais" })
    expect(s.theme).toBe("surface")
    expect(s.scenes.every((x) => x.durSec > 0)).toBe(true)
  })
})
