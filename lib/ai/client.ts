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
  model?: string // sobrescreve o modelo padrão do produto (config por tenant)
}

export async function callStructured<T>(opts: StructuredOpts): Promise<{ data: T; model: string }> {
  if (!isAiConfigured()) throw new Error("ANTHROPIC_API_KEY não configurada.")
  const client = new Anthropic()

  const response = await client.messages.create({
    model: opts.model || AI_MODEL,
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

/** Extrai o objeto JSON do texto do modelo: tira cercas ``` e pega do 1º { ao último }. */
function extractJson(text: string): string {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const start = t.indexOf("{")
  const end = t.lastIndexOf("}")
  return start >= 0 && end > start ? t.slice(start, end + 1) : t
}

// Variante SEM gramática (sem output_config.json_schema): pede JSON no prompt e faz
// parse defensivo. Para schemas que a gramática do structured output recusa por
// tamanho ("Schema is too complex.") — ex.: o motion, que expressa várias formas de
// conteúdo. Quem chama já valida/normaliza os campos (não depende de enforcement).
export async function callJson<T>(opts: StructuredOpts): Promise<{ data: T; model: string }> {
  if (!isAiConfigured()) throw new Error("ANTHROPIC_API_KEY não configurada.")
  const client = new Anthropic()

  const system =
    opts.system +
    "\n\nResponda SOMENTE com um objeto JSON válido (sem markdown, sem comentários, sem texto fora do " +
    "JSON) que siga este JSON Schema:\n" +
    JSON.stringify(opts.schema)

  const response = await client.messages.create({
    model: opts.model || AI_MODEL,
    max_tokens: opts.maxTokens ?? 8000,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: opts.user }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming)

  if (response.stop_reason === "refusal") throw new Error("O modelo recusou a solicitação (política de conteúdo).")
  if (response.stop_reason === "max_tokens") throw new Error("Resposta truncada (max_tokens). Tente novamente ou reduza o conteúdo.")

  const text = response.content.find((b) => b.type === "text")
  if (!text || text.type !== "text") throw new Error("Resposta do modelo sem conteúdo de texto.")
  try {
    return { data: JSON.parse(extractJson(text.text)) as T, model: response.model }
  } catch {
    throw new Error("Não foi possível interpretar a resposta do modelo (JSON inválido).")
  }
}
