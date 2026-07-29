import { describe, it, expect } from "vitest"
import {
  statSourceInBrief,
  generateMotion,
  MOTION_PRESETS,
  MOTION_ASPECTS,
  type MotionBrief,
} from "./motion"

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
  it("gera uma peça válida e NUNCA escolhe stat (não há número verificável)", async () => {
    const c = await generateMotion("5 sinais de que sua PME precisa de um CRM")
    expect(MOTION_PRESETS).toContain(c.preset)
    expect(c.preset).not.toBe("stat")
    expect(c.preset).toBe("headline")
    expect(c.props.kind).toBe("headline")
    expect(MOTION_ASPECTS).toContain(c.aspect)
    expect(c.title.length).toBeGreaterThan(0)
  })
})
