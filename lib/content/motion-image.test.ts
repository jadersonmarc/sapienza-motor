import { describe, it, expect } from "vitest"
import { scrimForPreset } from "./motion-image"

describe("scrimForPreset (scrim adaptativo)", () => {
  it("imagem ESCURA fica no piso do preset (não abaixa)", () => {
    expect(scrimForPreset("headline", 0.2)).toBeCloseTo(0.55) // floor > adaptive(0.45)
    expect(scrimForPreset("quote", 0.1)).toBeCloseTo(0.4)
  })
  it("imagem CLARA sobe o scrim acima do piso (legibilidade)", () => {
    expect(scrimForPreset("quote", 0.9)).toBeGreaterThan(0.4)
    expect(scrimForPreset("quote", 0.9)).toBeCloseTo(0.8)
    // clara sobe até acima do piso mais alto também
    expect(scrimForPreset("headline", 1)).toBeCloseTo(0.85)
  })
  it("teto 0.85 e preset desconhecido cai no default 0.5", () => {
    expect(scrimForPreset("headline", 5)).toBe(0.85) // clamp de lum + teto
    expect(scrimForPreset("desconhecido", 0)).toBeCloseTo(0.5)
  })
})
