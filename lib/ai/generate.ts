import Anthropic from "@anthropic-ai/sdk"
import { slugify } from "@/lib/content/slug"

// Seam de geração de conteúdo (Claude). Se ANTHROPIC_API_KEY estiver ausente, cai
// num rascunho determinístico (permite operar/testar sem chave) — mesmo padrão de
// fallback do Margot. Extração completa dos geradores ricos (draft/brief/social/
// analyzers) de spa-sapienza/lib/ai/* é fast-follow.

export const AI_MODEL = "claude-opus-4-8"

export type Draft = { title: string; slug: string; bodyMarkdown: string; excerpt: string }

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "slug", "excerpt", "bodyMarkdown"],
  properties: {
    title: { type: "string" },
    slug: { type: "string" },
    excerpt: { type: "string" },
    bodyMarkdown: { type: "string" },
  },
} as const

export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

export async function generateDraft(prompt: string): Promise<Draft> {
  if (!isAiConfigured()) {
    const base = prompt.trim() || "Rascunho"
    return {
      title: base.slice(0, 80),
      slug: slugify(base) || "rascunho",
      excerpt: base.slice(0, 140),
      bodyMarkdown: `# ${base}\n\n(rascunho gerado sem IA — configure ANTHROPIC_API_KEY)`,
    }
  }
  const client = new Anthropic()
  const res = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 4000,
    system:
      "Você é um redator pt-BR. Gere uma peça de conteúdo curta e on-brand a partir do tema. " +
      "Responda SOMENTE com JSON no schema pedido (title, slug, excerpt, bodyMarkdown em markdown).",
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: `Tema: ${prompt}` }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming)
  const block = res.content.find((b) => b.type === "text")
  if (!block || block.type !== "text") throw new Error("resposta do modelo sem texto")
  const data = JSON.parse(block.text) as Draft
  if (!data.slug) data.slug = slugify(data.title)
  return data
}
