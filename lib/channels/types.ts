// Abstração de canal de publicação — análoga ao WhatsAppDriver do Margot. O
// pipeline é agnóstico de provedor; impls concretas (instagram/linkedin/blog) e
// MockChannel (testes) implementam esta interface.

export type Platform =
  | "instagram"
  | "linkedin"
  | "blog"
  | "facebook"
  | "twitter"
  | "threads"
  | "wordpress"
  | "webhook"

export const PLATFORMS: Platform[] = [
  "instagram",
  "linkedin",
  "blog",
  "facebook",
  "twitter",
  "threads",
  "wordpress",
  "webhook",
]

export type PublishInput = {
  slug: string
  title: string
  body: string
  imageUrl?: string // URL pública (obrigatória p/ Instagram)
  videoUrl?: string // MP4 da peça de motion. Fase 1: só o canal Webhook usa.
  // FASE 2: publicação nativa de vídeo (Instagram Reels, LinkedIn video) — cada
  // canal passa a ler videoUrl e usar o fluxo de vídeo da sua API. Não implementado
  // na Fase 1 (motion publica só pelo Webhook).
}

export interface Channel {
  readonly platform: Platform
  publish(input: PublishInput, credentials: string | null): Promise<{ url: string }>
}
