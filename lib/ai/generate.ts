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
  "Você é redator(a) da Sapienza Labs, um estúdio de software sob medida para PMEs da " +
  "Baixada Fluminense. Escreva em pt-BR correto e natural, com acentuação adequada. " +
  "Conteúdo original, útil e específico — sem clichês de IA. Não invente dados ou clientes."

// Renovação de tema (cron editorial): evita repetir o que já existe e semeia
// ângulos novos. Adaptado de spa-sapienza/lib/ai/draft.themeGuidance.
export type DraftThemeContext = { avoidTitles?: string[]; themeSeeds?: string[] }

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

export async function generateDraft(prompt: string, ctx?: DraftThemeContext): Promise<Draft> {
  const theme = prompt.trim() || "Conteúdo para PMEs da Baixada Fluminense"

  if (!isAiConfigured()) {
    return {
      title: theme.slice(0, 80),
      slug: slugify(theme) || "rascunho",
      excerpt: theme.slice(0, 140),
      bodyMarkdown: `# ${theme}\n\n(rascunho gerado sem IA — configure ANTHROPIC_API_KEY)`,
      keywords: [],
    }
  }

  const user =
    `Escreva um artigo de blog a partir do tema abaixo.\n\nTEMA: ${theme}\n\n` +
    "Requisitos: título objetivo; slug em kebab-case; excerpt curto; corpo em Markdown " +
    "(use ## para subtítulos, listas quando ajudar; 600–900 palavras); 5–8 keywords de SEO. " +
    "Inclua um CTA leve para falar com a Sapienza Labs no WhatsApp ao final." +
    themeGuidance(ctx)

  const { data } = await callStructured<Draft>({ system: SYSTEM, user, schema: SCHEMA, maxTokens: 16000 })
  return {
    title: data.title.trim(),
    slug: slugify(data.slug || data.title),
    bodyMarkdown: data.bodyMarkdown.trim(),
    excerpt: data.excerpt.trim(),
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
  }
}
