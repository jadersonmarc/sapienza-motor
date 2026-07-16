import { readFileSync } from "node:fs"
import { join } from "node:path"

// Fontes da marca em TTF (Satori não aceita woff2/CSS) — embutidas no PNG,
// sem fallback do SO e sem FOUT. Lidas uma vez no carregamento do módulo.
const dir = join(process.cwd(), "assets/fonts")
const load = (file: string) => readFileSync(join(dir, file))

export const ogFonts = [
  { name: "Bricolage Grotesque", data: load("BricolageGrotesque-Bold.ttf"), weight: 700 as const, style: "normal" as const },
  { name: "Bricolage Grotesque", data: load("BricolageGrotesque-SemiBold.ttf"), weight: 600 as const, style: "normal" as const },
  { name: "IBM Plex Sans", data: load("IBMPlexSans-Regular.ttf"), weight: 400 as const, style: "normal" as const },
  { name: "IBM Plex Sans", data: load("IBMPlexSans-SemiBold.ttf"), weight: 600 as const, style: "normal" as const },
  { name: "IBM Plex Mono", data: load("IBMPlexMono-Medium.ttf"), weight: 500 as const, style: "normal" as const },
]
