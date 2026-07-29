import { slugify } from "@/lib/content/slug"
import { MOTION_PRESETS, type MotionPreset, type MotionAspect, type MotionProps } from "@/lib/content/motion-types"
import { callStructured, isAiConfigured } from "./client"

export { MOTION_PRESETS }
export type { MotionPreset, MotionAspect, MotionProps }

// Geração de peça de MOTION (vídeo animado). A Margot escolhe qual dos 4 presets
// preenche melhor o conteúdo do brief e devolve os campos estruturados que o
// Remotion vai animar. Mesma voz/tom das peças estáticas (composeSystem). Seam:
// sem ANTHROPIC_API_KEY cai num stub determinístico (opera/testa sem chave).
//
// GUARDRAIL (AJUSTE 1): o preset `stat` (card de dado + contador) só pode ser
// escolhido quando houver um número VERIFICÁVEL no brief. O modelo preenche
// `source` com o trecho exato do brief de onde o número saiu; validamos que
// `source` é substring LITERAL do brief (case-insensitive + trim). Se não bater,
// descartamos `stat` e regeneramos SEM ele. Nunca deixamos ir ao ar um número
// inventado (silêncio=aprovado em 48h publicaria sob a marca do cliente).

// Aspectos que a geração pode escolher: feed (1x1/4x5) + story (9x16).
export const MOTION_ASPECTS: readonly MotionAspect[] = ["1x1", "4x5", "9x16"]

export type MotionContent = {
  preset: MotionPreset
  aspect: MotionAspect
  title: string // uso interno (lista)
  caption: string // legenda social (revisão + payload do webhook)
  props: MotionProps
}

export type MotionBrief = {
  systemPrompt?: string
  tone?: string
  themes?: string[]
  model?: string
}

const BASE_SYSTEM =
  "Você cria peças de conteúdo em MOVIMENTO (vídeo curto animado) para a Sapienza Labs, " +
  "startup de inteligência artificial. Escreva em pt-BR correto e natural. Conteúdo original, " +
  "útil e específico — sem clichês de IA. **Nunca invente dados, estatísticas, percentuais, " +
  "números ou clientes.**"

// Compõe o system: guardrails base + voz da marca + tom do tenant (mesma lógica de generate.ts).
function composeSystem(brief: MotionBrief, allowStat: boolean): string {
  let s = BASE_SYSTEM
  const extra = (brief.systemPrompt ?? "").trim()
  if (extra) s += `\n\nInstruções da marca:\n${extra}`
  const tone = (brief.tone ?? "").trim()
  if (tone) s += `\n\nTom desejado: ${tone}.`
  s +=
    "\n\nEscolha o preset que MELHOR representa o conteúdo:\n" +
    "- headline: uma manchete forte (poucas palavras), com UMA palavra a destacar.\n" +
    "- quote: uma citação/afirmação de marca, com uma frase-chave a destacar e a autoria.\n" +
    "- slides: 2 a 4 mini-cards (título curto por slide) — bom para listas/passos.\n"
  if (allowStat) {
    s +=
      "- stat: UM dado numérico (rótulo, valor, sufixo, subtítulo) — **use SOMENTE se houver um " +
      "número verificável já presente no brief acima**. Se usar stat, preencha `source` com o " +
      "trecho EXATO do brief de onde o número saiu. Se não houver número no brief, NÃO use stat.\n"
  } else {
    s += "- (o preset `stat` está indisponível nesta peça — escolha entre headline, quote ou slides.)\n"
  }
  s +=
    "\nPreencha APENAS o objeto do preset escolhido. Devolva também `title` (uso interno) e " +
    "`caption` (legenda pronta para publicar, pt-BR, praticamente sem emojis)."
  return s
}

function schemaFor(allowStat: boolean) {
  const presets = allowStat ? MOTION_PRESETS : (["headline", "quote", "slides"] as const)
  return {
    type: "object",
    additionalProperties: false,
    required: ["preset", "aspect", "title", "caption"],
    properties: {
      preset: { type: "string", enum: [...presets] },
      aspect: { type: "string", enum: [...MOTION_ASPECTS], description: "1x1/4x5 (feed) ou 9x16 (story vertical)" },
      title: { type: "string", description: "Título curto de uso interno" },
      caption: { type: "string", description: "Legenda pronta para publicar" },
      headline: {
        type: "object",
        additionalProperties: false,
        required: ["words", "highlightIndex"],
        properties: {
          words: { type: "array", items: { type: "string" }, description: "3–6 palavras da manchete" },
          highlightIndex: { type: "number", description: "índice (0-based) da palavra a destacar" },
        },
      },
      quote: {
        type: "object",
        additionalProperties: false,
        required: ["quote", "keyphrase", "author"],
        properties: {
          quote: { type: "string" },
          keyphrase: { type: "string", description: "trecho da citação a destacar (substring da citação)" },
          author: { type: "string" },
        },
      },
      slides: {
        type: "object",
        additionalProperties: false,
        required: ["slides"],
        properties: {
          slides: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["index", "title"],
              properties: { index: { type: "number" }, title: { type: "string" } },
            },
            description: "2 a 4 slides",
          },
        },
      },
      ...(allowStat
        ? {
            stat: {
              type: "object",
              additionalProperties: false,
              required: ["label", "value", "suffix", "subtitle", "source"],
              properties: {
                label: { type: "string" },
                value: { type: "number" },
                suffix: { type: "string", description: "ex.: %, x, mil (vazio se não houver)" },
                subtitle: { type: "string" },
                source: { type: "string", description: "trecho EXATO do brief de onde o número saiu" },
              },
            },
          }
        : {}),
    },
  } as const
}

type RawMotion = {
  preset: MotionPreset
  aspect: MotionAspect
  title: string
  caption: string
  headline?: { words: string[]; highlightIndex: number }
  quote?: { quote: string; keyphrase: string; author: string }
  slides?: { slides: { index: number; title: string }[] }
  stat?: { label: string; value: number; suffix: string; subtitle: string; source: string }
}

/** Texto do brief onde um `source` de stat precisa aparecer (substring literal). */
function briefText(brief: MotionBrief): string {
  return [brief.systemPrompt ?? "", ...(brief.themes ?? [])].join(" ")
}
function normalize(s: string): string {
  return s.toLowerCase().trim()
}
/** O `source` do stat é substring literal do brief? (teste binário, não semântico) */
export function statSourceInBrief(source: string, brief: MotionBrief): boolean {
  const src = normalize(source)
  if (!src) return false
  return normalize(briefText(brief)).includes(src)
}

function toProps(raw: RawMotion): MotionProps | null {
  switch (raw.preset) {
    case "headline":
      if (!raw.headline || !Array.isArray(raw.headline.words) || raw.headline.words.length === 0) return null
      return { kind: "headline", words: raw.headline.words, highlightIndex: raw.headline.highlightIndex }
    case "quote":
      if (!raw.quote?.quote) return null
      return { kind: "quote", ...raw.quote }
    case "slides": {
      const slides = (raw.slides?.slides ?? []).slice(0, 4)
      if (slides.length < 2) return null
      return { kind: "slides", slides: slides.map((s, i) => ({ index: i, title: s.title })) }
    }
    case "stat":
      if (!raw.stat) return null
      return { kind: "stat", ...raw.stat }
  }
}

async function callMotion(brief: MotionBrief, prompt: string, allowStat: boolean): Promise<RawMotion> {
  const user =
    `Crie UMA peça de motion a partir do tema/brief abaixo.\n\nTEMA: ${prompt.trim() || "(use o brief da marca)"}\n\n` +
    "Escolha o preset mais adequado e preencha só o objeto dele."
  const { data } = await callStructured<RawMotion>({
    system: composeSystem(brief, allowStat),
    user,
    schema: schemaFor(allowStat),
    maxTokens: 4000,
    model: brief.model,
  })
  return data
}

/** Stub determinístico sem IA (opera/testa sem ANTHROPIC_API_KEY). Nunca escolhe
 *  `stat` — não há número verificável. */
function fallback(prompt: string): MotionContent {
  const theme = prompt.trim() || "Conteúdo Sapienza Labs"
  const words = theme.split(/\s+/).filter(Boolean).slice(0, 4)
  const safeWords = words.length ? words : ["Sapienza", "Labs"]
  return {
    preset: "headline",
    aspect: "1x1",
    title: theme.slice(0, 80),
    caption: `${theme}\n\n(peça de motion gerada sem IA — configure ANTHROPIC_API_KEY)`,
    props: { kind: "headline", words: safeWords, highlightIndex: 0 },
  }
}

/** Gera o conteúdo de uma peça de motion a partir do brief do tenant. */
export async function generateMotion(prompt: string, brief: MotionBrief = {}): Promise<MotionContent> {
  if (!isAiConfigured()) return fallback(prompt)

  // 1ª tentativa: com `stat` disponível.
  let raw = await callMotion(brief, prompt, true)

  // Guardrail: se escolheu stat sem número rastreável no brief, regenera sem stat.
  if (raw.preset === "stat" && !(raw.stat && statSourceInBrief(raw.stat.source, brief))) {
    raw = await callMotion(brief, prompt, false)
  }

  let props = toProps(raw)
  // Rede de segurança: preset sem o objeto correspondente (ou stat ainda inválido) → sem stat.
  if (!props || (raw.preset === "stat" && !(raw.stat && statSourceInBrief(raw.stat.source, brief)))) {
    raw = await callMotion(brief, prompt, false)
    props = toProps(raw)
  }
  if (!props) return fallback(prompt) // último recurso, nunca quebra o pipeline

  const aspect: MotionAspect = MOTION_ASPECTS.includes(raw.aspect) ? raw.aspect : "1x1"
  return {
    preset: props.kind,
    aspect,
    title: (raw.title || prompt).trim().slice(0, 120) || slugify(prompt) || "Peça de motion",
    caption: (raw.caption || "").trim(),
    props,
  }
}
