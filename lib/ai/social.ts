import { callStructured, isAiConfigured } from "./client"

// Geradores de legenda social (IG/LinkedIn) — descritores puros (system + prompt +
// schema) + generateSocial com seam. Adaptado de spa-sapienza/lib/ai/social.
// Sem ANTHROPIC_API_KEY, cai num fallback determinístico (title/excerpt) para a
// publicação seguir mesmo sem IA.

export type SocialPlatform = "instagram" | "linkedin"

export type SocialInput = {
  title: string
  bodyMarkdown: string
  excerpt: string
  pilar: string | null
  url?: string
}

export type SocialResult = { body: string; hashtags: string[]; model: string | null }

export type SocialGenerator = {
  platform: SocialPlatform
  label: string
  system: string
  buildUser: (input: SocialInput) => string
  schema: Record<string, unknown>
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["body", "hashtags"],
  properties: {
    body: { type: "string", description: "Texto do post, pronto para publicar" },
    hashtags: { type: "array", items: { type: "string" }, description: "sem o #" },
  },
} as const

function block(i: SocialInput): string {
  return [
    `Artigo: ${i.title}`,
    `Resumo: ${i.excerpt}`,
    `Pilar: ${i.pilar ?? "-"}`,
    i.url ? `Link: ${i.url}` : "",
    "",
    "Conteúdo (Markdown):",
    i.bodyMarkdown,
  ]
    .filter(Boolean)
    .join("\n")
}

const BASE =
  "Você cuida das redes da Sapienza Labs (software sob medida para PMEs da Baixada " +
  "Fluminense). Escreva em pt-BR, natural e específico. Inclua um CTA para o link/WhatsApp. " +
  "Retorne hashtags sem o caractere #."

const generators: Record<SocialPlatform, SocialGenerator> = {
  instagram: {
    platform: "instagram",
    label: "Instagram",
    system: `${BASE} Tom acessível e caloroso; emojis com moderação; quebras de linha curtas.`,
    buildUser: (i) =>
      `Crie uma legenda de Instagram a partir do artigo. Gancho forte na 1ª linha, ` +
      `corpo escaneável e CTA. 8–12 hashtags relevantes (mix de alcance e nicho local).\n\n${block(i)}`,
    schema: SCHEMA,
  },
  linkedin: {
    platform: "linkedin",
    label: "LinkedIn",
    system: `${BASE} Tom profissional e direto; sem emojis em excesso; foco em valor de negócio.`,
    buildUser: (i) =>
      `Crie um post de LinkedIn a partir do artigo. Abertura que prende, 2–4 parágrafos ` +
      `curtos com insight prático para gestores de PME e CTA. 3–5 hashtags.\n\n${block(i)}`,
    schema: SCHEMA,
  },
}

export function getSocialGenerator(platform: SocialPlatform): SocialGenerator | undefined {
  return generators[platform]
}

export const SOCIAL_PLATFORMS: { platform: SocialPlatform; label: string }[] = Object.values(
  generators,
).map((g) => ({ platform: g.platform, label: g.label }))

export function isSocialPlatform(v: string): v is SocialPlatform {
  return v === "instagram" || v === "linkedin"
}

/** Gera a legenda social; sem IA cai num fallback (excerpt/title, sem hashtags). */
export async function generateSocial(
  platform: SocialPlatform,
  input: SocialInput,
): Promise<SocialResult> {
  const gen = generators[platform]
  if (!isAiConfigured()) {
    const body = (input.excerpt || input.title).trim()
    return { body: input.url ? `${body}\n\n${input.url}` : body, hashtags: [], model: null }
  }
  const { data, model } = await callStructured<{ body: string; hashtags: string[] }>({
    system: gen.system,
    user: gen.buildUser(input),
    schema: gen.schema,
  })
  return {
    body: data.body.trim(),
    hashtags: Array.isArray(data.hashtags) ? data.hashtags.map((h) => h.replace(/^#+/, "").trim()).filter(Boolean) : [],
    model,
  }
}
