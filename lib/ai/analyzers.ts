import { callStructured, isAiConfigured } from "./client"

// Analisadores de conteúdo (qualidade/SEO/emocional/temático) — descritores puros
// + runAnalyzer. Adaptado de spa-sapienza/lib/ai/analyzers. Diagnóstico: exigem
// ANTHROPIC_API_KEY (sem fallback — não há "análise determinística").

export type AnalysisType = "quality" | "seo" | "emotional" | "thematic"

export type AnalyzerInput = {
  title: string
  bodyMarkdown: string
  excerpt: string
  pilar: string | null
  keywords?: string[]
}

export type Analyzer = {
  type: AnalysisType
  label: string
  system: string
  buildUser: (input: AnalyzerInput) => string
  schema: Record<string, unknown>
}

export class AiNotConfiguredError extends Error {}

const strArray = { type: "array", items: { type: "string" } }

function contentBlock(i: AnalyzerInput): string {
  return [
    `Título: ${i.title}`,
    `Resumo: ${i.excerpt || "(sem resumo)"}`,
    `Pilar: ${i.pilar ?? "(página)"}`,
    i.keywords?.length ? `Keywords atuais: ${i.keywords.join(", ")}` : "",
    "",
    "Corpo (Markdown):",
    i.bodyMarkdown,
  ]
    .filter(Boolean)
    .join("\n")
}

const BASE_SYSTEM =
  "Você é editor(a) sênior da Sapienza Labs (conteúdo pt-BR para PMEs da Baixada " +
  "Fluminense). Seja específico e acionável; nada de generalidades. Responda em pt-BR."

const analyzers: Record<AnalysisType, Analyzer> = {
  quality: {
    type: "quality",
    label: "Qualidade",
    system: `${BASE_SYSTEM} Avalie qualidade, legibilidade e estrutura do texto.`,
    buildUser: (i) =>
      `Analise a qualidade do conteúdo abaixo. Dê um score de 0 a 100, um resumo do ` +
      `diagnóstico, pontos fortes e recomendações acionáveis.\n\n${contentBlock(i)}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["score", "summary", "strengths", "recommendations"],
      properties: {
        score: { type: "number", description: "0 a 100" },
        summary: { type: "string" },
        strengths: strArray,
        recommendations: strArray,
      },
    },
  },

  seo: {
    type: "seo",
    label: "SEO",
    system: `${BASE_SYSTEM} Avalie a visibilidade em busca (SEO on-page).`,
    buildUser: (i) =>
      `Avalie o SEO do conteúdo. Score 0-100, sugestão de título, meta description ` +
      `(<=160 caracteres), keywords sugeridas, dicas de headings e observações sobre ` +
      `densidade/uso de termos.\n\n${contentBlock(i)}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["score", "titleSuggestion", "metaDescription", "suggestedKeywords", "headingTips", "notes"],
      properties: {
        score: { type: "number", description: "0 a 100" },
        titleSuggestion: { type: "string" },
        metaDescription: { type: "string" },
        suggestedKeywords: strArray,
        headingTips: strArray,
        notes: strArray,
      },
    },
  },

  emotional: {
    type: "emotional",
    label: "Impacto emocional",
    system: `${BASE_SYSTEM} Avalie tom emocional e impacto do texto no leitor.`,
    buildUser: (i) =>
      `Analise o tom emocional e o impacto do conteúdo. Indique o tom dominante, um ` +
      `score de impacto 0-100, uma análise e sugestões para fortalecer a conexão com ` +
      `o leitor PME.\n\n${contentBlock(i)}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["dominantTone", "score", "analysis", "suggestions"],
      properties: {
        dominantTone: { type: "string" },
        score: { type: "number", description: "0 a 100" },
        analysis: { type: "string" },
        suggestions: strArray,
      },
    },
  },

  thematic: {
    type: "thematic",
    label: "Temática",
    system: `${BASE_SYSTEM} Extraia os temas e sugira áreas de conteúdo relacionadas.`,
    buildUser: (i) =>
      `Identifique os tópicos principais do conteúdo e sugira áreas de conteúdo ` +
      `relacionadas (ideias para o calendário editorial). Inclua um resumo temático.\n\n${contentBlock(i)}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["mainTopics", "relatedAreas", "summary"],
      properties: {
        mainTopics: strArray,
        relatedAreas: strArray,
        summary: { type: "string" },
      },
    },
  },
}

export function getAnalyzer(type: AnalysisType): Analyzer | undefined {
  return analyzers[type]
}

export const ANALYZER_LIST: { type: AnalysisType; label: string }[] = Object.values(analyzers).map(
  (a) => ({ type: a.type, label: a.label }),
)

export function isAnalysisType(v: string): v is AnalysisType {
  return v === "quality" || v === "seo" || v === "emotional" || v === "thematic"
}

/** Roda um analisador (exige IA). Retorna o payload estruturado + o modelo. */
export async function runAnalyzer(
  type: AnalysisType,
  input: AnalyzerInput,
): Promise<{ payload: unknown; model: string }> {
  if (!isAiConfigured()) throw new AiNotConfiguredError("ANTHROPIC_API_KEY não configurada.")
  const a = analyzers[type]
  const { data, model } = await callStructured<unknown>({
    system: a.system,
    user: a.buildUser(input),
    schema: a.schema,
  })
  return { payload: data, model }
}
