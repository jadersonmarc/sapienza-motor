import { describe, expect, it } from "vitest"
import { composeBrandImage, r2KeyFor, type ArchetypeId } from "./compose"
import { renderBrandImage } from "./render"

// File-system por finalidade (lib/storage/keys.ts): canal do formato → pasta.
// (r2KeyFor no Motor não recebe mais `pilar`.)
describe("r2KeyFor", () => {
  it("imagem social do IG cai em social/instagram/", () => {
    expect(r2KeyFor({ slug: "fila-de-mensagens", formatId: "ig-feed" })).toBe(
      "social/instagram/fila-de-mensagens__ig-feed.png",
    )
  })

  it("OG do blog cai em articles/<slug>/", () => {
    expect(r2KeyFor({ slug: "retrabalho-manual", formatId: "blog-og" })).toBe(
      "articles/retrabalho-manual/blog-og.png",
    )
  })
})

describe("composeBrandImage (pilar texto livre, default on-brand)", () => {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  // bastidores exige uma imagem de fundo (coberto em render.test com data-URI).
  const archetypes: ArchetypeId[] = ["capa", "conceito", "diagrama", "carrossel"]

  for (const archetype of archetypes) {
    it(`${archetype}: pilar desconhecido rende PNG válido`, async () => {
      const { format, node } = composeBrandImage({
        archetype,
        formatId: "ig-feed",
        pilar: "algo-que-nao-existe",
        text: "Peça de teste",
        nodes: [{ label: "A" }, { label: "B", key: true }],
      })
      const buf = Buffer.from(await renderBrandImage(format, node).arrayBuffer())
      expect(buf.subarray(0, 4)).toEqual(PNG_MAGIC)
    })
  }
})
