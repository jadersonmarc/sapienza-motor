import { describe, it, expect } from "vitest"
import { scrimForPreset, mediaKeyFromUrl, imageDataUri } from "./motion-image"

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

describe("mediaKeyFromUrl (URL pública → chave do R2)", () => {
  it("extrai a chave depois de /api/media/<tenant>/", () => {
    expect(mediaKeyFromUrl("https://motor.x.com/api/media/abc-123/editor/2026/08/uuid.jpg")).toBe(
      "editor/2026/08/uuid.jpg",
    )
    expect(mediaKeyFromUrl("https://m/api/media/t/geral/x.png")).toBe("geral/x.png")
  })
  it("null quando a URL não tem o formato de mídia", () => {
    expect(mediaKeyFromUrl("https://exemplo.com/imagem.jpg")).toBeNull()
    expect(mediaKeyFromUrl("")).toBeNull()
  })
})

describe("imageDataUri (bytes → data URI embutido no render)", () => {
  it("monta data URI base64 com o content-type", () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(imageDataUri("image/png", bytes)).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`)
  })
  it("cai em image/jpeg quando o content-type é indefinido", () => {
    expect(imageDataUri(undefined, new Uint8Array([255]))).toMatch(/^data:image\/jpeg;base64,/)
  })
})
