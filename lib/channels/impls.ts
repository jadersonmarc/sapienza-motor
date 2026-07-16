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

export class FacebookChannel implements Channel {
  readonly platform: Platform = "facebook"
  async publish(input: PublishInput, credentials: string | null): Promise<{ url: string }> {
    if (!credentials) throw new Error("facebook: credenciais ausentes")
    const { access_token, page_id } = JSON.parse(credentials) as {
      access_token: string
      page_id: string
    }
    const base = "https://graph.facebook.com/v21.0"
    const message = `${input.title}\n\n${input.body}`
    // Post com link (imagem) usa /photos; sem imagem, /feed.
    const endpoint = input.imageUrl ? `${base}/${page_id}/photos` : `${base}/${page_id}/feed`
    const body = input.imageUrl
      ? { url: input.imageUrl, caption: message, access_token }
      : { message, access_token }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`facebook ${input.imageUrl ? "photos" : "feed"}: ${res.status}`)
    const { id, post_id } = (await res.json()) as { id: string; post_id?: string }
    return { url: `https://www.facebook.com/${post_id ?? id}` }
  }
}

export class TwitterChannel implements Channel {
  readonly platform: Platform = "twitter"
  async publish(input: PublishInput, credentials: string | null): Promise<{ url: string }> {
    if (!credentials) throw new Error("twitter: credenciais ausentes")
    const { access_token, username } = JSON.parse(credentials) as {
      access_token: string
      username?: string
    }
    // X API v2: cria um tweet (texto). Respeita o limite de 280 caracteres.
    const text = input.body.slice(0, 280)
    const res = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) throw new Error(`twitter tweets: ${res.status}`)
    const { data } = (await res.json()) as { data: { id: string } }
    return { url: `https://x.com/${username ?? "i"}/status/${data.id}` }
  }
}

export class ThreadsChannel implements Channel {
  readonly platform: Platform = "threads"
  async publish(input: PublishInput, credentials: string | null): Promise<{ url: string }> {
    if (!credentials) throw new Error("threads: credenciais ausentes")
    const { access_token, user_id } = JSON.parse(credentials) as {
      access_token: string
      user_id: string
    }
    const base = "https://graph.threads.net/v1.0"
    // 1) cria o container (texto ou imagem)
    const create = await fetch(`${base}/${user_id}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: input.imageUrl ? "IMAGE" : "TEXT",
        text: input.body,
        ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
        access_token,
      }),
    })
    if (!create.ok) throw new Error(`threads create: ${create.status}`)
    const { id: creationId } = (await create.json()) as { id: string }
    // 2) publica o container
    const pub = await fetch(`${base}/${user_id}/threads_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: creationId, access_token }),
    })
    if (!pub.ok) throw new Error(`threads publish: ${pub.status}`)
    const { id } = (await pub.json()) as { id: string }
    return { url: `https://www.threads.net/t/${id}` }
  }
}
