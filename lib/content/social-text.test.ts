import { describe, expect, it } from "vitest"
import { parseHashtags } from "./social-text"

describe("parseHashtags", () => {
  it("remove #, separa por espaço/vírgula e deduplica preservando ordem", () => {
    expect(parseHashtags("#pme, #automacao  automacao #juridico")).toEqual([
      "pme",
      "automacao",
      "juridico",
    ])
  })
  it("string vazia → []", () => {
    expect(parseHashtags("   ")).toEqual([])
  })
})
