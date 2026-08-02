import { slugify } from "@/lib/content/slug"
import {
  MOTION_PRESETS,
  MOTION_ARCHETYPES,
  type MotionPreset,
  type MotionAspect,
  type MotionProps,
  type MotionField,
  type MotionArchetype,
  type MotionScene,
  type SceneBlock,
  type StoryProps,
} from "@/lib/content/motion-types"
import { MOTION_MOODS, trackFor, quantizeToBeat, type MotionMood } from "@/lib/content/motion-audio"
import { callStructured, isAiConfigured } from "./client"

export { MOTION_PRESETS, MOTION_ARCHETYPES }
export type { MotionPreset, MotionAspect, MotionProps, MotionArchetype }

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
    "\n\nO vídeo é um ROTEIRO curto com abertura (HOOK), meio e CHAMADA final (CTA). Primeiro escolha o " +
    "ARQUÉTIPO que melhor conta este conteúdo:\n" +
    "- highlight: um destaque único (manchete/citação/lista/dado). O padrão quando não há estrutura clara.\n" +
    "- list: uma sequência de 2 a 5 passos/itens curtos (preencha `list_items`).\n" +
    "- myth_fact: desfaz um engano — um mito e a verdade (preencha `myth` e `fact`).\n" +
    "- before_after: contraste antes/depois (preencha `before` e `after`).\n" +
    "- qa: uma pergunta que o público faz e a resposta (preencha `question` e `answer`).\n" +
    "\nSempre preencha também o preset de DESENVOLVIMENTO (usado no arquétipo `highlight` e como " +
    "reserva se faltar conteúdo do arquétipo). Escolha o preset que melhor representa o conteúdo:\n" +
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
    "- `hook_words`: 2 a 5 palavras de abertura que fisguem a atenção (não repita a manchete literalmente).\n" +
    "- `cta_text`: uma chamada final curta e específica (ex.: 'Fale com a gente', 'Saiba mais'), sem link.\n" +
    "- `theme`: 'ink' (fundo escuro) ou 'surface' (fundo claro) — escolha o que combina com o tema.\n" +
    "- `audio`: clima da trilha — 'calm' (sóbrio/institucional), 'upbeat' (dinâmico/varejo), 'bold' " +
    "(impactante) ou 'none' (sem trilha). Escolha o que combina com o conteúdo.\n" +
    "\nPreencha APENAS o objeto do preset de desenvolvimento escolhido. Devolva também `title` (uso " +
    "interno) e `caption` (legenda pronta para publicar, pt-BR, praticamente sem emojis)."
  return s
}

// Schema ACHATADO de propósito: campos de arquétipo/hook/cta como escalares/arrays
// no topo (não objetos aninhados) e SEM `additionalProperties`/`required` aninhados.
// Grammar-constrained decoding (output_config.json_schema) compila o schema numa
// gramática; muitos objetos aninhados + additionalProperties:false estouravam a
// compilação ("Grammar compilation timed out"). Achatar mantém a geração barata.
function schemaFor(allowStat: boolean) {
  const presets = allowStat ? MOTION_PRESETS : (["headline", "quote", "slides"] as const)
  const strArray = (description: string) => ({ type: "array", items: { type: "string" }, description })
  return {
    type: "object",
    required: ["preset", "archetype", "aspect", "title", "caption"],
    properties: {
      preset: { type: "string", enum: [...presets] },
      archetype: { type: "string", enum: [...MOTION_ARCHETYPES], description: "estrutura do roteiro" },
      aspect: { type: "string", enum: [...MOTION_ASPECTS], description: "1x1/4x5 (feed) ou 9x16 (story vertical)" },
      title: { type: "string", description: "Título curto de uso interno" },
      caption: { type: "string", description: "Legenda pronta para publicar" },
      theme: { type: "string", enum: ["ink", "surface"], description: "fundo escuro (ink) ou claro (surface)" },
      audio: { type: "string", enum: [...MOTION_MOODS], description: "clima da trilha (none = sem trilha)" },
      // Abertura + chamada (achatados).
      hook_words: strArray("2–5 palavras de abertura"),
      cta_text: { type: "string", description: "chamada final curta (sem link)" },
      // Conteúdo por arquétipo (achatado — preencha só o do arquétipo escolhido).
      list_items: strArray("archetype list: 2 a 5 passos/itens curtos"),
      myth: { type: "string", description: "archetype myth_fact: o engano" },
      fact: { type: "string", description: "archetype myth_fact: a verdade" },
      before: { type: "string", description: "archetype before_after: o antes" },
      after: { type: "string", description: "archetype before_after: o depois" },
      question: { type: "string", description: "archetype qa: a pergunta" },
      answer: { type: "string", description: "archetype qa: a resposta" },
      // Desenvolvimento (usado no highlight e como reserva).
      headline: {
        type: "object",
        properties: {
          words: strArray("3–6 palavras da manchete"),
          highlightIndex: { type: "number", description: "índice (0-based) da palavra a destacar" },
        },
      },
      quote: {
        type: "object",
        properties: {
          quote: { type: "string" },
          keyphrase: { type: "string", description: "trecho da citação a destacar (substring da citação)" },
          author: { type: "string" },
        },
      },
      slides: {
        type: "object",
        properties: {
          slides: {
            type: "array",
            items: { type: "object", properties: { index: { type: "number" }, title: { type: "string" } } },
            description: "2 a 4 slides",
          },
        },
      },
      ...(allowStat
        ? {
            stat: {
              type: "object",
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
  archetype?: MotionArchetype
  aspect: MotionAspect
  title: string
  caption: string
  theme?: MotionField
  audio?: MotionMood
  hook_words?: string[]
  cta_text?: string
  list_items?: string[]
  myth?: string
  fact?: string
  before?: string
  after?: string
  question?: string
  answer?: string
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

// Durações (segundos). Hook e CTA fixos; desenvolvimento varia com o bloco.
const HOOK_SEC = 1.6
const CTA_SEC = 2.0
const STMT_SEC = 2.2
function developSec(block: SceneBlock): number {
  if (block.kind === "slides") return Math.min(6, Math.max(3, block.slides.length * 1.2))
  if (block.kind === "stat") return 3.5
  return 3
}

const clean = (s: string | undefined): string => (s ?? "").trim()
function stmt(role: MotionScene["role"], label: string | undefined, text: string, durSec = STMT_SEC): MotionScene {
  return { role, durSec, block: { kind: "statement", label, text } }
}

/** Monta o roteiro conforme o ARQUÉTIPO, a partir do bloco de desenvolvimento e dos
 *  campos hook/cta/theme + conteúdo do arquétipo. Garante SEMPRE hook e CTA (deriva
 *  se faltar) e cai no desenvolvimento quando o conteúdo do arquétipo não vem. Puro. */
export function buildStory(
  archetype: MotionArchetype,
  develop: SceneBlock,
  raw: Pick<
    RawMotion,
    "hook_words" | "cta_text" | "theme" | "audio" | "list_items" | "myth" | "fact" | "before" | "after" | "question" | "answer"
  >,
  prompt: string,
): StoryProps {
  const hookWords = (raw.hook_words ?? []).map((w) => w.trim()).filter(Boolean).slice(0, 5)
  const fallbackHook = (prompt.trim().split(/\s+/).filter(Boolean).slice(0, 4).join(" ") || "Sapienza").split(/\s+/)
  const hookScene: MotionScene = {
    role: "hook",
    durSec: HOOK_SEC,
    block: { kind: "headline", words: hookWords.length >= 2 ? hookWords : fallbackHook, highlightIndex: 0 },
  }
  const ctaScene: MotionScene = { role: "cta", durSec: CTA_SEC, block: { kind: "cta", text: clean(raw.cta_text) || "Fale com a gente" } }
  const theme: MotionField = raw.theme === "surface" ? "surface" : "ink"
  const developScene: MotionScene = { role: "develop", durSec: developSec(develop), block: develop }

  // Cenas do meio por arquétipo; reserva = o desenvolvimento (sempre existe).
  let lead = hookScene
  let middle: MotionScene[] = [developScene]

  if (archetype === "list") {
    const items = (raw.list_items ?? []).map(clean).filter(Boolean).slice(0, 5)
    if (items.length >= 2) {
      middle = items.map((t, i) => stmt("develop", `${String(i + 1).padStart(2, "0")}`, t, 1.8))
    }
  } else if (archetype === "myth_fact") {
    const myth = clean(raw.myth)
    const fact = clean(raw.fact)
    if (myth && fact) middle = [stmt("develop", "Mito", myth, 2.4), stmt("develop", "Verdade", fact, 2.6)]
  } else if (archetype === "before_after") {
    const before = clean(raw.before)
    const after = clean(raw.after)
    if (before && after) middle = [stmt("develop", "Antes", before, 2.4), stmt("develop", "Depois", after, 2.6)]
  } else if (archetype === "qa") {
    const q = clean(raw.question)
    const a = clean(raw.answer)
    if (q && a) {
      lead = stmt("hook", "Pergunta", q, 2.2)
      middle = [stmt("develop", "Resposta", a, 2.8)]
    }
  }

  const audio: MotionMood = MOTION_MOODS.includes(raw.audio as MotionMood) ? (raw.audio as MotionMood) : "none"
  let scenes = [lead, ...middle, ctaScene]
  // Beat-sync: com trilha, encaixa a duração de cada cena na grade de batidas do BPM.
  const track = trackFor(audio)
  if (track) scenes = scenes.map((s) => ({ ...s, durSec: quantizeToBeat(s.durSec, track.bpm) }))
  return { kind: "story", scenes, theme, audio }
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
    props: buildStory("highlight", develop, {}, prompt),
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

  const archetype: MotionArchetype = MOTION_ARCHETYPES.includes(raw.archetype as MotionArchetype)
    ? (raw.archetype as MotionArchetype)
    : "highlight"
  const aspect: MotionAspect = MOTION_ASPECTS.includes(raw.aspect) ? raw.aspect : "9x16"
  return {
    preset: "story",
    aspect,
    title: (raw.title || prompt).trim().slice(0, 120) || slugify(prompt) || "Peça de motion",
    caption: (raw.caption || "").trim(),
    props: buildStory(archetype, develop, raw, prompt),
  }
}
