import { cpSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// Copia os MESMOS TTF de ../assets/fonts (fonte única do motor) para public/fonts,
// de onde o Remotion (staticFile) os serve. Não versionar public/fonts.
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..") // motion/
const src = join(root, "..", "assets", "fonts") // sapienza-motor/assets/fonts
const dest = join(root, "public", "fonts")

mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log(`[motion] fontes copiadas: ${src} → ${dest}`)
