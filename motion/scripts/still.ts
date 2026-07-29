import { bundle } from "@remotion/bundler"
import { selectComposition, renderStill } from "@remotion/renderer"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync } from "node:fs"
import { MOTION_PRESETS } from "../../lib/content/motion-types"
import { compositionId } from "../src/Root"
import { SAMPLES } from "../src/samples"

// Rende um still (PNG) de cada preset (1x1) num frame tardio p/ inspeção rápida.
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")

async function main() {
  const out = join(root, "out")
  mkdirSync(out, { recursive: true })
  const serveUrl = await bundle({ entryPoint: join(root, "src", "index.ts") })
  for (const preset of MOTION_PRESETS) {
    const id = compositionId(preset, "1x1")
    const inputProps = { aspect: "1x1", brandHandle: "@sapienzalabs", data: SAMPLES[preset] }
    const composition = await selectComposition({ serveUrl, id, inputProps })
    const output = join(out, `${preset}-still.png`)
    await renderStill({ composition, serveUrl, output, frame: 120, inputProps })
    console.log("still", output)
  }
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
