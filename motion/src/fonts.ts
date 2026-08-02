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
  // Timeout folgado no delayRender; mas o cap abaixo garante continuar bem antes.
  const handle = delayRender("loading brand fonts", { timeoutInMilliseconds: 60000 })
  const load = Promise.all(
    faces.map((f) =>
      loadFont({ family: f.family, url: staticFile(`fonts/${f.file}`), weight: f.weight, style: "normal" }),
    ),
  ).catch((err) => {
    console.error("[motion/fonts] falha ao carregar:", err)
  })
  // Cap: o carregamento de fonte NUNCA pode travar o render. Se em 10s não resolver
  // (ex.: fonte não servida no ambiente de render), seguimos com o fallback do
  // navegador — vídeo com fonte de sistema é melhor que render falho.
  const cap = new Promise<void>((resolve) => setTimeout(resolve, 10000))
  Promise.race([load, cap]).finally(() => continueRender(handle))
}

export { fonts }
