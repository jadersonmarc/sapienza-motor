import { slugify } from "@/lib/content/slug"
import {
  MOTION_PRESETS,
  type MotionPreset,
  type MotionAspect,
  type MotionProps,
  type MotionField,
  type MotionScene,
  type SceneBlock,
  type StoryProps,
} from "@/lib/content/motion-types"
import { callStructured, isAiConfigured } from "./client"

export { MOTION_PRESETS }
export type { MotionPreset, MotionAspect, MotionProps }

// Geração de peça de MOTION (vídeo animado). A Margot devolve um ROTEIRO de cenas
// (hook → desenvolvimento → CTA): escolhe o bloco de DESENVOLVIMENTO (um dos presets
// de cena única) + um hook curto de abertura + a chamada final. O código monta o
// StoryProps (preset `story`) que o Remotion anima com <Series>. Mesma voz/tom das
// peças estáticas (composeSystem). Seam: sem ANTHROPIC_API_KEY cai num stub
// determinístico (opera/testa sem chave).
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
    "\n\nO vídeo é um ROTEIRO curto com 3 momentos: um HOOK de abertura, o DESENVOLVIMENTO e uma " +
    "CHAMADA final. Escolha o preset de DESENVOLVIMENTO que MELHOR representa o conteúdo:\n" +
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
    "\nAlém do desenvolvimento, devolva:\n" +
    "- `hook`: 2 a 5 palavras de abertura que fisguem a atenção (não repita a manchete literalmente).\n" +
    "- `cta`: uma chamada final curta e específica (ex.: 'Fale com a gente', 'Saiba mais'), sem link.\n" +
    "- `theme`: 'ink' (fundo escuro) ou 'surface' (fundo claro) — escolha o que combina com o tema.\n" +
    "\nPreencha APENAS o objeto do preset de desenvolvimento escolhido. Devolva também `title` (uso " +
    "interno) e `caption` (legenda pronta para publicar, pt-BR, praticamente sem emojis)."
  return s
}

function schemaFor(allowStat: boolean) {
  const presets = allowStat ? MOTION_PRESETS : (["headline", "quote", "slides"] as const)
  return {
    type: "object",
    additionalProperties: false,
    required: ["preset", "aspect", "title", "caption", "hook", "cta"],
    properties: {
      preset: { type: "string", enum: [...presets] },
      aspect: { type: "string", enum: [...MOTION_ASPECTS], description: "1x1/4x5 (feed) ou 9x16 (story vertical)" },
      title: { type: "string", description: "Título curto de uso interno" },
      caption: { type: "string", description: "Legenda pronta para publicar" },
      theme: { type: "string", enum: ["ink", "surface"], description: "fundo escuro (ink) ou claro (surface)" },
      hook: {
        type: "object",
        additionalProperties: false,
        required: ["words"],
        properties: {
          words: { type: "array", items: { type: "string" }, description: "2–5 palavras de abertura" },
        },
      },
      cta: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", description: "chamada final curta (sem link)" } },
      },
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
  theme?: MotionField
  hook?: { words: string[] }
  cta?: { text: string }
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

// Extrai o BLOCO de desenvolvimento escolhido pelo modelo. null se o objeto do
// preset não veio válido (o chamador regenera / cai no fallback).
function toProps(raw: RawMotion): SceneBlock | null {
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
    default:
      return null
  }
}

// Duração (segundos) da cena de desenvolvimento conforme o bloco: slides pedem mais
// tempo (um por card); os demais ~3s. Hook e CTA têm duração fixa.
const HOOK_SEC = 1.6
const CTA_SEC = 2.0
function developSec(block: SceneBlock): number {
  if (block.kind === "slides") return Math.min(6, Math.max(3, block.slides.length * 1.2))
  if (block.kind === "stat") return 3.5
  return 3
}

/** Monta o roteiro de 3 cenas (hook → desenvolvimento → CTA) a partir do bloco de
 *  desenvolvimento e dos campos hook/cta/theme. Garante SEMPRE hook e CTA (deriva se
 *  o modelo omitir). Puro e testável. */
export function buildStory(develop: SceneBlock, raw: Pick<RawMotion, "hook" | "cta" | "theme">, prompt: string): StoryProps {
  const hookWords = (raw.hook?.words ?? []).map((w) => w.trim()).filter(Boolean).slice(0, 5)
  const fallbackHook = (prompt.trim().split(/\s+/).filter(Boolean).slice(0, 4).join(" ") || "Sapienza").split(/\s+/)
  const hookBlock: SceneBlock = {
    kind: "headline",
    words: hookWords.length >= 2 ? hookWords : fallbackHook,
    highlightIndex: 0,
  }
  const ctaText = (raw.cta?.text ?? "").trim() || "Fale com a gente"
  const ctaBlock: SceneBlock = { kind: "cta", text: ctaText }
  const theme: MotionField = raw.theme === "surface" ? "surface" : "ink"
  const scenes: MotionScene[] = [
    { role: "hook", durSec: HOOK_SEC, block: hookBlock },
    { role: "develop", durSec: developSec(develop), block: develop },
    { role: "cta", durSec: CTA_SEC, block: ctaBlock },
  ]
  return { kind: "story", scenes, theme }
}

async function callMotion(brief: MotionBrief, prompt: string, allowStat: boolean): Promise<RawMotion> {
  const user =
    `Crie UMA peça de motion (roteiro hook → desenvolvimento → CTA) a partir do tema/brief abaixo.\n\n` +
    `TEMA: ${prompt.trim() || "(use o brief da marca)"}\n\n` +
    "Escolha o preset de desenvolvimento mais adequado e preencha só o objeto dele, além de hook, cta e theme."
  const { data } = await callStructured<RawMotion>({
    system: composeSystem(brief, allowStat),
    user,
    schema: schemaFor(allowStat),
    maxTokens: 4000,
    model: brief.model,
  })
  return data
}

/** Stub determinístico sem IA (opera/testa sem ANTHROPIC_API_KEY). Roteiro mínimo
 *  (hook → manchete → CTA), NUNCA com `stat` (não há número verificável). */
function fallback(prompt: string): MotionContent {
  const theme = prompt.trim() || "Conteúdo Sapienza Labs"
  const words = theme.split(/\s+/).filter(Boolean).slice(0, 4)
  const safeWords = words.length ? words : ["Sapienza", "Labs"]
  const develop: SceneBlock = { kind: "headline", words: safeWords, highlightIndex: 0 }
  return {
    preset: "story",
    aspect: "9x16",
    title: theme.slice(0, 80),
    caption: `${theme}\n\n(peça de motion gerada sem IA — configure ANTHROPIC_API_KEY)`,
    props: buildStory(develop, {}, prompt),
  }
}

/** Gera o conteúdo de uma peça de motion (roteiro multi-cena) a partir do brief. */
export async function generateMotion(prompt: string, brief: MotionBrief = {}): Promise<MotionContent> {
  if (!isAiConfigured()) return fallback(prompt)

  // 1ª tentativa: com `stat` disponível no desenvolvimento.
  let raw = await callMotion(brief, prompt, true)

  // Guardrail: se escolheu stat sem número rastreável no brief, regenera sem stat.
  if (raw.preset === "stat" && !(raw.stat && statSourceInBrief(raw.stat.source, brief))) {
    raw = await callMotion(brief, prompt, false)
  }

  let develop = toProps(raw)
  // Rede de segurança: preset sem o objeto correspondente (ou stat ainda inválido) → sem stat.
  if (!develop || (raw.preset === "stat" && !(raw.stat && statSourceInBrief(raw.stat.source, brief)))) {
    raw = await callMotion(brief, prompt, false)
    develop = toProps(raw)
  }
  if (!develop) return fallback(prompt) // último recurso, nunca quebra o pipeline

  const aspect: MotionAspect = MOTION_ASPECTS.includes(raw.aspect) ? raw.aspect : "9x16"
  return {
    preset: "story",
    aspect,
    title: (raw.title || prompt).trim().slice(0, 120) || slugify(prompt) || "Peça de motion",
    caption: (raw.caption || "").trim(),
    props: buildStory(develop, raw, prompt),
  }
}
