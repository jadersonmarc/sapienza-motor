import { cpSync, mkdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// Copia os assets de ../assets (fonte única do motor) para public/, de onde o
// Remotion (staticFile) os serve. Não versionar public/. Fontes são obrigatórias;
// áudio é opcional (seam): sem faixas em assets/audio, o vídeo sai mudo.
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..") // motion/
const assets = join(root, "..", "assets") // sapienza-motor/assets

const fontsSrc = join(assets, "fonts")
const fontsDest = join(root, "public", "fonts")
mkdirSync(fontsDest, { recursive: true })
cpSync(fontsSrc, fontsDest, { recursive: true })
console.log(`[motion] fontes copiadas: ${fontsSrc} → ${fontsDest}`)

const audioSrc = join(assets, "audio")
const audioDest = join(root, "public", "audio")
if (existsSync(audioSrc)) {
  mkdirSync(audioDest, { recursive: true })
  cpSync(audioSrc, audioDest, { recursive: true })
  console.log(`[motion] trilhas copiadas: ${audioSrc} → ${audioDest}`)
} else {
  console.log("[motion] sem assets/audio — vídeo sai mudo (seam)")
}
