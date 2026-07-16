import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

// Floor: os templates só consomem cores de tokens.ts. Qualquer cor literal
// (hex, rgb/rgba, hsl, oklch) num template é proibida — falha o build.
const dir = dirname(fileURLToPath(import.meta.url))
const templates = readdirSync(dir).filter((f) => f.endsWith(".tsx"))

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\s*\(/g

describe("guarda anti-cor-solta nos templates", () => {
  it("há templates para checar", () => {
    expect(templates.length).toBeGreaterThan(0)
  })

  for (const file of templates) {
    it(`${file} não tem cor literal`, () => {
      const src = readFileSync(join(dir, file), "utf8")
      const hits = src.match(COLOR_LITERAL) ?? []
      expect(hits).toEqual([])
    })
  }
})
