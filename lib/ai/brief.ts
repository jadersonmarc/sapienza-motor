import { slugify } from "@/lib/content/slug"
import { callStructured, isAiConfigured } from "./client"

// Produtor SEPARADO do cron (lib/ai/generate.ts): gera um rascunho a partir de um
// brief livre do operador (objetivo, pontos-chave, público, tom). Por decisão de
// projeto NÃO compartilha código com o gerador do cron (não-regressão) — só o
// cliente estruturado. Adaptado de spa-sapienza/lib/ai/brief (sem vertentes; o
// Motor usa pilar como texto livre).

export type BriefInput = {
  objetivo: string
  pontosChave?: string
  publico?: string
  tom?: string
  pilar?: string | null
}

export type BriefDraft = {
  title: string
  slug: string
  excerpt: string
  bodyMarkdown: string
  keywords: string[]
  model: string | null
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "slug", "excerpt", "bodyMarkdown", "keywords"],
  properties: {
    title: { type: "string", description: "Título claro e atraente" },
    slug: { type: "string", description: "slug-em-minusculas-com-hifens" },
    excerpt: { type: "string", description: "Resumo de 1–2 frases" },
    bodyMarkdown: { type: "string", description: "Corpo em Markdown (## headings, listas, ~600-900 palavras)" },
    keywords: { type: "array", items: { type: "string" }, description: "5-8 palavras-chave de SEO" },
  },
} as const

const SYSTEM =
  "Você é redator(a) da Sapienza Labs (pt-BR), startup de inteligência artificial. Conteúdo " +
  "original, útil e específico — sem clichês de IA. Não invente dados ou clientes."

// Monta o prompt do usuário a partir do brief (parte pura, testável).
export function buildBriefUser(input: BriefInput): string {
  const tom = (input.tom ?? "").trim()
  const lines = [
    "Escreva um artigo a partir do brief abaixo.",
    "",
    `OBJETIVO / EXPECTATIVA: ${input.objetivo.trim()}`,
    input.pontosChave?.trim() ? `PONTOS-CHAVE:\n${input.pontosChave.trim()}` : "",
    input.publico?.trim() ? `PÚBLICO: ${input.publico.trim()}` : "",
    input.pilar?.trim() ? `PILAR: ${input.pilar.trim()}` : "",
    tom ? `TOM: ${tom}` : "",
    "",
    "Requisitos: título objetivo; slug em kebab-case; excerpt curto; corpo em Markdown " +
      "(use ## para subtítulos, listas quando ajudar; 600–900 palavras); 5–8 keywords de SEO.",
  ]
  return lines.filter(Boolean).join("\n")
}

export async function generateFromBrief(input: BriefInput): Promise<BriefDraft> {
  const objetivo = input.objetivo.trim()
  if (!isAiConfigured()) {
    const base = objetivo || "Rascunho por brief"
    return {
      title: base.slice(0, 80),
      slug: slugify(base) || "rascunho",
      excerpt: base.slice(0, 140),
      bodyMarkdown: `# ${base}\n\n(rascunho gerado sem IA — configure ANTHROPIC_API_KEY)`,
      keywords: [],
      model: null,
    }
  }

  const { data, model } = await callStructured<{
    title: string
    slug: string
    excerpt: string
    bodyMarkdown: string
    keywords: string[]
  }>({ system: SYSTEM, user: buildBriefUser(input), schema: SCHEMA, maxTokens: 16000 })

  return {
    title: data.title.trim(),
    slug: slugify(data.slug || data.title),
    excerpt: data.excerpt.trim(),
    bodyMarkdown: data.bodyMarkdown.trim(),
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
    model,
  }
}
