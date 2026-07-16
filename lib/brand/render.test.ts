import { describe, expect, it } from "vitest"
import { getFormat } from "./formats"
import { renderBrandImage } from "./render"
import { CapaEditorial } from "./templates/capa-editorial"
import { CardConceito } from "./templates/card-conceito"
import { Diagrama } from "./templates/diagrama"
import { CarrosselSlide } from "./templates/carrossel-slide"
import { Bastidores } from "./templates/bastidores"
import type { ReactElement } from "react"

// PNG 1x1 transparente — stand-in da foto de bastidores (sem dep de arquivo).
const PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

async function png(node: ReactElement, fmt = getFormat("ig-feed")): Promise<Buffer> {
  const res = await renderBrandImage(fmt, node)
  return Buffer.from(await res.arrayBuffer())
}

const cases: Record<string, () => ReactElement> = {
  "capa-editorial": () =>
    CapaEditorial({ format: getFormat("ig-feed"), field: "ink", eyebrow: "ENG/AI · 01", title: "Título de teste", footer: "SAPIENZA LABS" }),
  "card-conceito": () =>
    CardConceito({ format: getFormat("ig-feed"), field: "surface", eyebrow: "INSIGHT · 02", phrase: "Uma frase de teste.", footer: "SAPIENZA LABS" }),
  diagrama: () =>
    Diagrama({ format: getFormat("ig-feed"), field: "ink", eyebrow: "ENG/AI · 03", nodes: [{ label: "A" }, { label: "B", key: true }, { label: "C" }], footer: "SAPIENZA LABS" }),
  "carrossel-slide": () =>
    CarrosselSlide({ format: getFormat("ig-feed"), field: "ink", index: 1, total: 5, eyebrow: "SÉRIE", kind: "cover", text: "Capa da série" }),
  bastidores: () => Bastidores({ format: getFormat("ig-feed"), imageUrl: PX, caption: "Legenda de teste." }),
}

describe("renderer dos arquétipos", () => {
  for (const [name, build] of Object.entries(cases)) {
    it(`${name}: gera PNG válido`, async () => {
      const buf = await png(build())
      expect(buf.subarray(0, 4)).toEqual(PNG_MAGIC)
      expect(buf.length).toBeGreaterThan(1000)
    })
  }

  it("é determinístico (mesma entrada → mesmo PNG)", async () => {
    const a = await png(cases["capa-editorial"]())
    const b = await png(cases["capa-editorial"]())
    expect(a.equals(b)).toBe(true)
  })
})
