import { slugify } from "@/lib/content/slug"
import { callStructured, isAiConfigured, AI_MODEL } from "./client"

// Geração de rascunho de conteúdo (Claude, structured output). Seam: sem
// ANTHROPIC_API_KEY cai num rascunho determinístico (permite operar/testar sem
// chave) — mesmo padrão do Margot. Adaptado de spa-sapienza/lib/ai/draft.

export { AI_MODEL, isAiConfigured }

export type Draft = {
  title: string
  slug: string
  bodyMarkdown: string
  excerpt: string
  keywords: string[]
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "slug", "excerpt", "bodyMarkdown", "keywords"],
  properties: {
    title: { type: "string", description: "Título objetivo e atraente" },
    slug: { type: "string", description: "slug-em-minusculas-com-hifens" },
    excerpt: { type: "string", description: "Resumo de 1–2 frases" },
    bodyMarkdown: { type: "string", description: "Corpo em Markdown (## subtítulos, listas; 600–900 palavras)" },
    keywords: { type: "array", items: { type: "string" }, description: "5–8 palavras-chave de SEO" },
  },
} as const

const SYSTEM =
  "Você é redator(a) profissional escrevendo para a MARCA descrita nas instruções abaixo. " +
  "Adote a identidade, o produto e o público dessa marca — não represente nem cite outra empresa. " +
  "Escreva em pt-BR correto e natural, com acentuação adequada. " +
  "Conteúdo original, útil e específico — sem clichês de IA. Não invente dados ou clientes."

// Formato da peça = o canal-alvo. blog = artigo longo/SEO; linkedin/instagram =
// post curto no tom do canal, gerado direto do tema (não derivado de um artigo).
export type ContentFormat = "blog" | "linkedin" | "instagram"

const SOCIAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body", "hashtags"],
  properties: {
    title: { type: "string", description: "Título curto (uso interno; identifica a peça)" },
    body: { type: "string", description: "Texto do post, pronto para publicar" },
    hashtags: { type: "array", items: { type: "string" }, description: "hashtags relevantes, sem o #" },
  },
} as const

const SOCIAL_SYSTEM: Record<"linkedin" | "instagram", string> = {
  linkedin:
    "Você escreve posts de LinkedIn para a MARCA descrita nas instruções abaixo (não cite outra empresa). " +
    "pt-BR, tom profissional e direto: abertura que prende, 2–4 parágrafos curtos com insight " +
    "prático e um CTA leve ao final. Sem clichês de IA.",
  instagram:
    "Você escreve legendas de Instagram para a MARCA descrita nas instruções abaixo (não cite outra empresa). " +
    "pt-BR, tom acessível e caloroso: gancho forte na 1ª linha, corpo escaneável e um CTA. " +
    "Praticamente sem emojis (no máximo 1). Sem clichês de IA.",
}

async function socialDraft(theme: string, platform: "linkedin" | "instagram", ctx?: DraftThemeContext): Promise<Draft> {
  const nTags = platform === "instagram" ? "8–12" : "3–5"
  const label = platform === "linkedin" ? "LinkedIn" : "Instagram"
  const user =
    `Crie um post de ${label} a partir do tema abaixo.\n\nTEMA: ${theme}\n\n` +
    `Requisitos: um título curto (uso interno); o texto do post pronto para publicar; ${nTags} hashtags relevantes (sem #).`
  const { data } = await callStructured<{ title: string; body: string; hashtags: string[] }>({
    system: composeSystem(SOCIAL_SYSTEM[platform], ctx),
    user,
    schema: SOCIAL_SCHEMA,
    maxTokens: 4000,
    model: ctx?.model,
  })
  const body = data.body.trim()
  const tags = (data.hashtags ?? []).map((h) => `#${h}`).join(" ")
  return {
    title: data.title.trim(),
    slug: slugify(data.title) || "post",
    bodyMarkdown: tags ? `${body}\n\n${tags}` : body,
    excerpt: body.slice(0, 140),
    keywords: data.hashtags ?? [],
  }
}

// Config de geração por tenant (aba "Agente"): personaliza voz/tom/modelo e os
// temas, além do contexto de renovação (avoidTitles). Tudo opcional — sem config,
// cai no comportamento base.
export type DraftThemeContext = {
  avoidTitles?: string[]
  themeSeeds?: string[]
  systemPrompt?: string
  tone?: string
  model?: string
}

// Compõe o system efetivo: guardrails base (neutros, sem marca) + a IDENTIDADE da
// marca (persona/voz do tenant) + o tom. A identidade vem SEMPRE do tenant — não há
// marca padrão; a criação é bloqueada antes disto se a persona não estiver definida.
function composeSystem(base: string, ctx?: DraftThemeContext): string {
  let s = base
  const extra = (ctx?.systemPrompt ?? "").trim()
  if (extra) s += `\n\nInstruções da marca:\n${extra}`
  const tone = (ctx?.tone ?? "").trim()
  if (tone) s += `\n\nTom desejado: ${tone}.`
  return s
}

export function themeGuidance(ctx?: DraftThemeContext): string {
  const avoid = (ctx?.avoidTitles ?? []).filter(Boolean).slice(0, 40)
  const seeds = (ctx?.themeSeeds ?? []).filter(Boolean).slice(0, 12)
  let block = ""
  if (avoid.length) {
    block += `\n\nTEMAS JÁ PUBLICADOS — NÃO repita nem reescreva variações destes:\n- ` + avoid.join("\n- ")
  }
  if (seeds.length) {
    block += `\n\nÁREAS SUGERIDAS para explorar (escolha UMA e aprofunde com ângulo próprio):\n- ` + seeds.join("\n- ")
  }
  block += "\n\nEscolha um tema NOVO, específico e claramente diferente dos já publicados."
  return block
}

export async function generateDraft(
  prompt: string,
  format: ContentFormat = "blog",
  ctx?: DraftThemeContext,
): Promise<Draft> {
  const theme = prompt.trim() || "Um tema relevante para a marca e seu público"

  if (!isAiConfigured()) {
    return {
      title: theme.slice(0, 80),
      slug: slugify(theme) || "rascunho",
      excerpt: theme.slice(0, 140),
      bodyMarkdown: `${theme}\n\n(rascunho gerado sem IA — configure ANTHROPIC_API_KEY)`,
      keywords: [],
    }
  }

  if (format === "linkedin" || format === "instagram") {
    return socialDraft(theme, format, ctx)
  }

  const user =
    `Escreva um artigo de blog a partir do tema abaixo.\n\nTEMA: ${theme}\n\n` +
    "Requisitos: título objetivo; slug em kebab-case; excerpt curto; corpo em Markdown " +
    "(use ## para subtítulos, listas quando ajudar; 600–900 palavras); 5–8 keywords de SEO. " +
    "Feche com um CTA leve e natural, coerente com a marca (sem citar outra empresa)." +
    themeGuidance(ctx)

  const { data } = await callStructured<Draft>({
    system: composeSystem(SYSTEM, ctx),
    user,
    schema: SCHEMA,
    maxTokens: 16000,
    model: ctx?.model,
  })
  return {
    title: data.title.trim(),
    slug: slugify(data.slug || data.title),
    bodyMarkdown: data.bodyMarkdown.trim(),
    excerpt: data.excerpt.trim(),
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
  }
}
