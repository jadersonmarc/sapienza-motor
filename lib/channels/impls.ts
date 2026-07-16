import type { Channel, Platform, PublishInput } from "./types"

// Impls concretas. Blog é canal interno (sem credencial). Instagram e LinkedIn
// falam com as APIs oficiais (adaptado de spa-sapienza/lib/social/*); só rodam em
// produção — nos testes usamos MockChannel. Credenciais chegam decifradas (JSON).

export class BlogChannel implements Channel {
  readonly platform: Platform = "blog"
  async publish(input: PublishInput): Promise<{ url: string }> {
    // Canal interno: "publicar" = o post já está no blog do tenant pela slug.
    return { url: `/blog/${input.slug}` }
  }
}

export class InstagramChannel implements Channel {
  readonly platform: Platform = "instagram"
  async publish(input: PublishInput, credentials: string | null): Promise<{ url: string }> {
    if (!credentials) throw new Error("instagram: credenciais ausentes")
    if (!input.imageUrl) throw new Error("instagram: imagem (URL pública) obrigatória")
    const { access_token, account_id } = JSON.parse(credentials) as {
      access_token: string
      account_id: string
    }
    const base = "https://graph.facebook.com/v21.0"
    // 1) cria o container de mídia
    const create = await fetch(`${base}/${account_id}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: input.imageUrl, caption: input.body, access_token }),
    })
    if (!create.ok) throw new Error(`instagram media: ${create.status}`)
    const { id: creationId } = (await create.json()) as { id: string }
    // 2) publica o container
    const pub = await fetch(`${base}/${account_id}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: creationId, access_token }),
    })
    if (!pub.ok) throw new Error(`instagram publish: ${pub.status}`)
    const { id: mediaId } = (await pub.json()) as { id: string }
    return { url: `https://www.instagram.com/p/${mediaId}` }
  }
}

export class LinkedinChannel implements Channel {
  readonly platform: Platform = "linkedin"
  async publish(input: PublishInput, credentials: string | null): Promise<{ url: string }> {
    if (!credentials) throw new Error("linkedin: credenciais ausentes")
    const { access_token, author_urn } = JSON.parse(credentials) as {
      access_token: string
      author_urn: string
    }
    const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        author: author_urn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: `${input.title}\n\n${input.body}` },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    })
    if (!res.ok) throw new Error(`linkedin ugcPosts: ${res.status}`)
    const id = res.headers.get("x-restli-id") ?? ""
    return { url: `https://www.linkedin.com/feed/update/${id}` }
  }
}
