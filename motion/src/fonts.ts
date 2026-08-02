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
//
// Usa a API NATIVA FontFace (não @remotion/fonts): assim o ÚNICO delayRender é o
// nosso (com cap). O loadFont do @remotion/fonts criava um delayRender próprio que
// pendurava quando a URL da fonte não resolvia — e que o nosso cap não conseguia
// liberar, travando o render.
if (typeof FontFace !== "undefined" && typeof document !== "undefined") {
  const handle = delayRender("loading brand fonts", { timeoutInMilliseconds: 60000 })
  const load = Promise.all(
    faces.map(async (f) => {
      const face = new FontFace(f.family, `url(${staticFile(`fonts/${f.file}`)})`, {
        weight: f.weight,
        style: "normal",
      })
      await face.load()
      document.fonts.add(face)
    }),
  ).catch((err) => {
    // Não trava o render se uma face falhar — cai no fallback do navegador.
    console.error("[motion/fonts] falha ao carregar:", err)
  })
  // Cap: carregamento de fonte NUNCA pode travar o render. Se em 10s não resolver,
  // seguimos com o fallback do sistema — vídeo é melhor que render falho.
  const cap = new Promise<void>((resolve) => setTimeout(resolve, 10000))
  Promise.race([load, cap]).finally(() => continueRender(handle))
}

export { fonts }
