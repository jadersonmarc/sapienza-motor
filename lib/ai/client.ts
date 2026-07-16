import Anthropic from "@anthropic-ai/sdk"

// Cliente Claude com saída estruturada (json_schema), compartilhado pelos
// geradores (draft/social) e analisadores. Extraído de spa-sapienza/lib/ai/client.
// A geração em si é sempre um seam: quem chama decide o fallback quando não há
// ANTHROPIC_API_KEY (draft/social caem num determinístico; analyzers exigem chave).

export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

export const AI_MODEL = "claude-opus-4-8"

type StructuredOpts = {
  system: string
  user: string
  schema: Record<string, unknown>
  effort?: "low" | "medium" | "high"
  maxTokens?: number
}

export async function callStructured<T>(opts: StructuredOpts): Promise<{ data: T; model: string }> {
  if (!isAiConfigured()) throw new Error("ANTHROPIC_API_KEY não configurada.")
  const client = new Anthropic()

  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: opts.maxTokens ?? 8000,
    thinking: { type: "adaptive" },
    output_config: {
      format: { type: "json_schema", schema: opts.schema },
      effort: opts.effort ?? "medium",
    },
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming)

  if (response.stop_reason === "refusal") {
    throw new Error("O modelo recusou a solicitação (política de conteúdo).")
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Resposta truncada (max_tokens). Tente novamente ou reduza o conteúdo.")
  }

  const text = response.content.find((b) => b.type === "text")
  if (!text || text.type !== "text") {
    throw new Error("Resposta do modelo sem conteúdo de texto.")
  }
  try {
    return { data: JSON.parse(text.text) as T, model: response.model }
  } catch {
    throw new Error("Não foi possível interpretar a resposta do modelo (JSON inválido).")
  }
}
