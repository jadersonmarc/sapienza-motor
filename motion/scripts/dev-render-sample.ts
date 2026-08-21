// Render de AMOSTRA em dev — prova que a peça de motion usa a imagem de fundo, sem
// rodar nada em produção. Renderiza um preset DUAS vezes (com imagem e sem) e salva
// PNGs para comparação direta. Usa exatamente o mesmo caminho do worker: data URI da
// imagem embutido no render (nenhum acesso a rede/URL pública).
//
//   pnpm tsx motion/scripts/dev-render-sample.ts [imagem.png] [preset] [saída/dir]
//   preset ∈ headline|quote|stat|slides (default headline). Sem imagem = usa uma
//   imagem de teste vermelho|azul gerada com ffmpeg se nenhuma for passada.
import { bundle } from "@remotion/bundler"
import { selectComposition, renderStill } from "@remotion/renderer"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { compositionId } from "../src/Root"
import { imageDataUri } from "../../lib/content/motion-image"
import type { MotionProps } from "../../lib/content/motion-types"

const SAMPLE: Record<string, MotionProps> = {
  headline: { kind: "headline", words: ["Fundo", "de", "imagem", "no", "motion"], highlightIndex: 2 },
  quote: { kind: "quote", quote: "A imagem de fundo aparece atrás do texto.", keyphrase: "imagem de fundo", author: "Teste" },
  stat: { kind: "stat", label: "Cobertura", value: 87, suffix: "%", subtitle: "com imagem de fundo", source: "teste" },
  slides: { kind: "slides", slides: [{ title: "Slide um" }, { title: "Slide dois" }, { title: "Slide três" }] },
}

async function ensureTestImage(): Promise<string> {
  const out = join(tmpdir(), `bg-test-${Date.now()}.png`)
  const r = spawnSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=red:s=540x960:d=1",
    "-f", "lavfi", "-i", "color=c=blue:s=540x960:d=1",
    "-filter_complex", "[0][1]hstack", "-frames:v", "1", out,
  ])
  if (r.status !== 0) throw new Error("não consegui gerar a imagem de teste (ffmpeg)")
  return out
}

async function main(): Promise<void> {
  const imgArg = process.argv[2]
  const preset = process.argv[3] || "headline"
  const outDir = process.argv[4] || join(process.cwd(), ".dev-render")
  if (!SAMPLE[preset]) throw new Error(`preset inválido: ${preset} (use headline|quote|stat|slides)`)
  await mkdir(outDir, { recursive: true })

  const imgPath = imgArg && existsSync(imgArg) ? imgArg : await ensureTestImage()
  const bytes = await readFile(imgPath)
  const dataUri = imageDataUri(imgPath.endsWith(".jpg") || imgPath.endsWith(".jpeg") ? "image/jpeg" : "image/png", bytes)
  console.log(`imagem: ${imgPath} (${(bytes.length / 1024).toFixed(1)} KB)`)

  console.log("bundlando Remotion…")
  const serveUrl = await bundle({ entryPoint: join(process.cwd(), "src", "index.ts") })
  const id = compositionId(preset as never, "9x16")
  const data = SAMPLE[preset]

  for (const [label, image] of [
    ["com-imagem", { url: dataUri, scrimOpacity: 0.5 }],
    ["sem-imagem", null],
  ] as const) {
    const inputProps = { aspect: "9x16", brandHandle: "@teste", image, data }
    const composition = await selectComposition({ serveUrl, id, inputProps })
    const output = join(outDir, `${preset}-${label}.png`)
    await renderStill({ composition, serveUrl, output, frame: 40, inputProps, imageFormat: "png" })
    const st = await readFile(output)
    console.log(`✓ ${label}: ${output} (${(st.length / 1024).toFixed(1)} KB)`)
  }
  console.log(`\nCompare os dois PNGs em ${outDir}: "com-imagem" deve mostrar o fundo vermelho|azul sob o scrim; "sem-imagem" é o campo chapado.`)
  await writeFile(join(outDir, "README.txt"), "com-imagem = fundo da foto sob scrim · sem-imagem = campo chapado\n")
}

main().catch((e) => {
  console.error("render de amostra falhou:", e)
  process.exit(1)
})
