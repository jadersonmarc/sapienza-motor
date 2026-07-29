import { bundle } from "@remotion/bundler"
import { selectComposition, renderMedia } from "@remotion/renderer"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync } from "node:fs"
import { MOTION_PRESETS } from "../../lib/content/motion-types"
import { ALL_ASPECTS } from "../src/aspects"
import { compositionId } from "../src/Root"
import { SAMPLES } from "../src/samples"

// Renderiza um MP4 de cada preset × formato (12) em motion/out/ para inspeção
// local. licenseKey presente (default "free-license", sobrescrevível por env).
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const licenseKey = process.env.REMOTION_LICENSE_KEY ?? "free-license"

async function main() {
  const out = join(root, "out")
  mkdirSync(out, { recursive: true })
  const serveUrl = await bundle({ entryPoint: join(root, "src", "index.ts") })

  for (const preset of MOTION_PRESETS) {
    for (const aspect of ALL_ASPECTS) {
      const id = compositionId(preset, aspect)
      const inputProps = { aspect, brandHandle: "@sapienzalabs", data: SAMPLES[preset] }
      const composition = await selectComposition({ serveUrl, id, inputProps })
      const outputLocation = join(out, `${id}.mp4`)
      const opts = {
        composition,
        serveUrl,
        codec: "h264" as const,
        outputLocation,
        inputProps,
        licenseKey,
      }
      await renderMedia(opts as Parameters<typeof renderMedia>[0])
      console.log("[motion] renderizado", outputLocation)
    }
  }
  console.log("[motion] pronto — veja motion/out/")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
