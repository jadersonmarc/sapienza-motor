import { loadFont } from "@remotion/fonts"
import { staticFile, delayRender, continueRender } from "remotion"
import { fonts } from "../../lib/brand/tokens"

// Fontes da marca (os MESMOS TTF de ../assets/fonts, copiados para public/fonts
// pelo copy-assets). Famílias vêm de tokens.ts (fonte única). Carregadas no topo
// do módulo com delayRender — nada de FOUT nem dependência de rede no render.
const faces = [
  { family: fonts.display, file: "BricolageGrotesque-Bold.ttf", weight: "700" },
  { family: fonts.display, file: "BricolageGrotesque-SemiBold.ttf", weight: "600" },
  { family: fonts.sans, file: "IBMPlexSans-Regular.ttf", weight: "400" },
  { family: fonts.sans, file: "IBMPlexSans-SemiBold.ttf", weight: "600" },
  { family: fonts.mono, file: "IBMPlexMono-Medium.ttf", weight: "500" },
]

// Só carrega no contexto de render (Chromium tem FontFace); ao ser importado por um
// script Node (bundler/worker) isto é um no-op silencioso.
if (typeof FontFace !== "undefined") {
  const handle = delayRender("loading brand fonts")
  Promise.all(
    faces.map((f) =>
      loadFont({ family: f.family, url: staticFile(`fonts/${f.file}`), weight: f.weight, style: "normal" }),
    ),
  )
    .then(() => continueRender(handle))
    .catch((err) => {
      // Não trava o render se uma face falhar — cai no fallback do navegador.
      console.error("[motion/fonts] falha ao carregar:", err)
      continueRender(handle)
    })
}

export { fonts }
