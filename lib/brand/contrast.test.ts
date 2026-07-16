import { describe, expect, it } from "vitest"
import { fieldStyle, type Field } from "./tokens"
import { AA_LARGE, AA_TEXT, contrastRatio } from "./contrast"

// Floor: AA garantido nos dois campos. Texto principal ≥ 4.5; acento (sublinhado
// gráfico + eyebrow grande) ≥ 3.0. Falha o build se a paleta cair abaixo disso.
describe("contraste AA por campo", () => {
  for (const field of ["ink", "surface"] as Field[]) {
    const f = fieldStyle[field]
    it(`${field}: texto (fg sobre bg) ≥ AA`, () => {
      expect(contrastRatio(f.fg, f.bg)).toBeGreaterThanOrEqual(AA_TEXT)
    })
    it(`${field}: acento sobre bg ≥ AA large`, () => {
      expect(contrastRatio(f.accent, f.bg)).toBeGreaterThanOrEqual(AA_LARGE)
    })
  }
})
