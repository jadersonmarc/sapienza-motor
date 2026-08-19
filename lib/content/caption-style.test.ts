import { describe, it, expect } from "vitest"
import { fieldStyle, fonts, colors } from "@/lib/brand/tokens"
import { resolveCaption, motionFallbacks, sanitizeCaptionStyle, captionSizePct } from "./caption-style"

describe("resolveCaption (motion: default byte a byte)", () => {
  it("sem estilo → display/fg/accent do campo (idêntico ao render atual)", () => {
    const r = resolveCaption(undefined, motionFallbacks("ink"))
    expect(r.fontFamily).toBe(fonts.display)
    expect(r.color).toBe(fieldStyle.ink.fg)
    expect(r.highlight).toBe(fieldStyle.ink.accent)
  })
  it("cores semânticas resolvem a tokens (nunca CSS livre)", () => {
    const r = resolveCaption({ font: "mono", color: "signal", highlight: "accent" }, motionFallbacks("ink"))
    expect(r.fontFamily).toBe(fonts.mono)
    expect(r.color).toBe(colors.signal.hex)
    expect(r.highlight).toBe(colors.petrolSoft.hex)
  })
})

describe("resolveCaption (clipper: fallbacks do contexto sobre vídeo)", () => {
  it("sem estilo → branco + signal (defaults atuais do karaokê)", () => {
    const r = resolveCaption(undefined, { textFallback: "#ffffff", highlightFallback: colors.signal.hex })
    expect(r.color).toBe("#ffffff")
    expect(r.highlight).toBe(colors.signal.hex)
  })
})

describe("sanitizeCaptionStyle (guardrail de tokens)", () => {
  it("mantém só enums válidos; descarta CSS/valores livres", () => {
    expect(sanitizeCaptionStyle({ font: "sans", color: "accent", highlight: "signal" })).toEqual({
      font: "sans",
      color: "accent",
      highlight: "signal",
    })
    expect(sanitizeCaptionStyle({ font: "Comic Sans", color: "#ff0000" })).toBeNull()
    expect(sanitizeCaptionStyle({})).toBeNull()
    expect(sanitizeCaptionStyle(null)).toBeNull()
    expect(sanitizeCaptionStyle("qualquer coisa")).toBeNull()
  })
})

describe("captionSizePct (clipper)", () => {
  it("md/indefinido = 5.2 (valor atual); sm/lg escalam", () => {
    expect(captionSizePct(undefined)).toBe(5.2)
    expect(captionSizePct("md")).toBe(5.2)
    expect(captionSizePct("sm")).toBeLessThan(5.2)
    expect(captionSizePct("lg")).toBeGreaterThan(5.2)
  })
})
