// Abstração de canal de publicação — análoga ao WhatsAppDriver do Margot. O
// pipeline é agnóstico de provedor; impls concretas (instagram/linkedin/blog) e
// MockChannel (testes) implementam esta interface.

export type Platform = "instagram" | "linkedin" | "blog" | "facebook" | "twitter" | "threads"

export const PLATFORMS: Platform[] = [
  "instagram",
  "linkedin",
  "blog",
  "facebook",
  "twitter",
  "threads",
]

export type PublishInput = {
  slug: string
  title: string
  body: string
  imageUrl?: string // URL pública (obrigatória p/ Instagram)
}

export interface Channel {
  readonly platform: Platform
  publish(input: PublishInput, credentials: string | null): Promise<{ url: string }>
}
