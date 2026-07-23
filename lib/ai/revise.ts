import { callStructured } from "./client"

// Reescreve a peça implementando APENAS a recomendação dada, preservando o resto,
// o tom e a acentuação. Devolve o conteúdo completo revisado — vira uma revisão
// PROPOSTA (não a atual). Adaptado de spa-sapienza/app/admin/content/ai-actions.

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    excerpt: { type: "string" },
    bodyMarkdown: { type: "string" },
  },
  required: ["title", "excerpt", "bodyMarkdown"],
  additionalProperties: false,
} as const

const SYSTEM =
  "Você é editor(a) sênior da Sapienza Labs (pt-BR), startup de inteligência artificial. " +
  "Reescreva o conteúdo implementando APENAS a recomendação indicada, preservando o resto, o " +
  "tom e a acentuação correta. Retorne o conteúdo completo revisado."

export async function reviseWithRecommendation(
  current: { title: string; bodyMarkdown: string; excerpt?: string | null },
  recommendation: string,
  type?: string,
): Promise<{ title: string; excerpt: string; bodyMarkdown: string }> {
  const user =
    `Recomendação a implementar${type ? ` (tipo ${type})` : ""}:\n${recommendation}\n\n` +
    `--- Conteúdo atual ---\nTítulo: ${current.title}\nResumo: ${current.excerpt ?? ""}\n\n` +
    `Corpo (Markdown):\n${current.bodyMarkdown}`

  const { data } = await callStructured<{ title: string; excerpt: string; bodyMarkdown: string }>({
    system: SYSTEM,
    user,
    schema: SCHEMA,
    maxTokens: 16000,
  })
  return data
}
