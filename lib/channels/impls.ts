import { createHmac } from "node:crypto"
import { marked } from "marked"
import type { Channel, Platform, PublishInput } from "./types"
import { readImageBytes } from "@/lib/storage/s3"

// Corta o texto ao limite da rede (com reticências), evitando 400 por tamanho.
function cap(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…"
}

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

// Blog do site do cliente em WordPress: publica via REST API nativa com
// Application Password (Basic Auth). O corpo (markdown) vira HTML e a capa
// on-brand entra como imagem destacada (featured_media).
export class WordpressChannel implements Channel {
  readonly platform: Platform = "wordpress"
  async publish(input: PublishInput, credentials: string | null): Promise<{ url: string }> {
    if (!credentials) throw new Error("wordpress: credenciais ausentes")
    const { site_url, username, app_password } = JSON.parse(credentials) as {
      site_url: string
      username: string
      app_password: string
    }
    const base = site_url.replace(/\/+$/, "")
    const auth = Buffer.from(`${username}:${app_password}`).toString("base64")

    // Capa como imagem destacada (best-effort — não pode impedir o post do texto).
    const featuredMedia = input.imageUrl
      ? await uploadWordpressMedia(base, auth, input.imageUrl, input.slug)
      : null

    const content = await marked.parse(input.body)
    const res = await fetch(`${base}/wp-json/wp/v2/posts`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        content,
        slug: input.slug,
        status: "publish",
        ...(featuredMedia ? { featured_media: featuredMedia } : {}),
      }),
    })
    if (!res.ok) throw new Error(`wordpress posts: ${res.status}`)
    const { link, id } = (await res.json()) as { link?: string; id: number }
    return { url: link ?? `${base}/?p=${id}` }
  }
}

// Baixa a imagem (URL pública) e sobe na biblioteca do WP; devolve o id da mídia
// ou null se qualquer passo falhar (a capa é opcional; o texto publica mesmo assim).
async function uploadWordpressMedia(
  base: string,
  auth: string,
  imageUrl: string,
  slug: string,
): Promise<number | null> {
  try {
    const img = await fetch(imageUrl)
    if (!img.ok) return null
    const contentType = img.headers.get("content-type") ?? "image/png"
    const ext = contentType.split("/")[1]?.split(";")[0] || "png"
    const bytes = await img.arrayBuffer()
    const res = await fetch(`${base}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${slug}.${ext}"`,
      },
      body: bytes,
    })
    if (!res.ok) return null
    const { id } = (await res.json()) as { id: number }
    return id ?? null
  } catch {
    return null
  }
}

// Blog de site sob medida / CMS headless: entrega a peça por webhook, assinada
// com HMAC-SHA256 (o segredo compartilhado) para o site confirmar a origem.
export class WebhookChannel implements Channel {
  readonly platform: Platform = "webhook"
  async publish(input: PublishInput, credentials: string | null): Promise<{ url: string }> {
    if (!credentials) throw new Error("webhook: credenciais ausentes")
    const { url, secret } = JSON.parse(credentials) as { url: string; secret: string }
    const payload = JSON.stringify({
      slug: input.slug,
      title: input.title,
      body_markdown: input.body,
      image_url: input.imageUrl ?? null,
      video_url: input.videoUrl ?? null, // MP4 da peça de motion (Fase 1)
      published_at: new Date().toISOString(),
    })
    const signature = createHmac("sha256", secret).update(payload).digest("hex")
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sapienza-Signature": `sha256=${signature}` },
      body: payload,
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`webhook: ${res.status}`)
    const data = (await res.json().catch(() => ({}))) as { url?: string }
    return { url: data.url ?? url }
  }
}

// Espera o container de vídeo/Reels do Instagram terminar o processamento (async).
// Poll GET ?fields=status_code até FINISHED; ERROR/timeout → lança.
async function waitForIgContainer(base: string, creationId: string, accessToken: string): Promise<void> {
  for (let i = 0; i < 15; i++) {
    const r = await fetch(`${base}/${creationId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`, {
      signal: AbortSignal.timeout(15000),
    })
    if (r.ok) {
      const { status_code } = (await r.json()) as { status_code?: string }
      if (status_code === "FINISHED") return
      if (status_code === "ERROR") throw new Error("instagram: processamento do vídeo falhou (ERROR)")
    }
    await new Promise((res) => setTimeout(res, 5000))
  }
  throw new Error("instagram: vídeo ainda processando (timeout) — tenta de novo no próximo ciclo")
}

export class InstagramChannel implements Channel {
  readonly platform: Platform = "instagram"
  async publish(input: PublishInput, credentials: string | null): Promise<{ url: string }> {
    if (!credentials) throw new Error("instagram: credenciais ausentes")
    const { access_token, account_id } = JSON.parse(credentials) as {
      access_token: string
      account_id: string
    }
    const base = "https://graph.facebook.com/v21.0"
    // 1) cria o container: Reels (vídeo/motion) ou imagem.
    let body: Record<string, unknown>
    if (input.videoUrl) {
      body = { media_type: "REELS", video_url: input.videoUrl, caption: cap(input.body, 2200), access_token }
    } else if (input.imageUrl) {
      body = { image_url: input.imageUrl, caption: cap(input.body, 2200), access_token }
    } else {
      throw new Error("instagram: gere a imagem ou o vídeo da peça antes de publicar")
    }
    const create = await fetch(`${base}/${account_id}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
    if (!create.ok) throw new Error(`instagram media: ${create.status} ${await create.text().catch(() => "")}`)
    const { id: creationId } = (await create.json()) as { id: string }
    // Vídeo é processado de forma assíncrona — espera ficar FINISHED antes de publicar.
    if (input.videoUrl) await waitForIgContainer(base, creationId, access_token)
    // 2) publica o container
    const pub = await fetch(`${base}/${account_id}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: creationId, access_token }),
      signal: AbortSignal.timeout(20000),
    })
    if (!pub.ok) throw new Error(`instagram publish: ${pub.status}`)
    const { id: mediaId } = (await pub.json()) as { id: string }
    return { url: `https://www.instagram.com/p/${mediaId}` }
  }
}

// Versão da LinkedIn Posts API (mensal, AAAAMM). O LinkedIn mantém só ~12 meses
// ativos e devolve 426 NONEXISTENT_VERSION quando a versão expira. Dá pra bumpar
// por env (LINKEDIN_API_VERSION) sem redeploy quando isso acontecer de novo.
const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION?.trim() || "202605"

// A Posts API usa "little text format": estes caracteres reservados precisam ser
// escapados com \. Over-escapar é seguro (renderiza literal); under-escapar dá 422.
function escapeLinkedinText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => "\\" + c)
}

// Timeout de toda chamada ao LinkedIn — sem isto, uma API lenta pendura o publish
// até o proxy cortar com 503. Falha rápida vira erro tratável, não gateway timeout.
const LI_TIMEOUT = 15000

// Resolve o urn:li:person do dono do token via OpenID userinfo (fallback /v2/me),
// para o usuário só precisar colar o access_token. Requer escopo openid/profile.
async function resolveLinkedinAuthor(accessToken: string): Promise<string> {
  const ui = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(LI_TIMEOUT),
  })
  if (ui.ok) {
    const { sub } = (await ui.json()) as { sub?: string }
    if (sub) return `urn:li:person:${sub}`
  }
  const me = await fetch("https://api.linkedin.com/v2/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(LI_TIMEOUT),
  })
  if (me.ok) {
    const { id } = (await me.json()) as { id?: string }
    if (id) return `urn:li:person:${id}`
  }
  throw new Error("linkedin: não foi possível resolver o autor pelo token (precisa do escopo openid/profile)")
}

// Sobe a imagem on-brand pro LinkedIn (initializeUpload no /rest/images → PUT dos
// bytes lidos direto do storage) e devolve o URN da mídia. Best-effort: qualquer
// falha → null (post sai só com texto). Roda no publish em segundo plano, então
// os segundos do upload não estouram o proxy. Loga o motivo ([linkedin-image]).
async function uploadLinkedinImage(accessToken: string, authorUrn: string, imageUrl: string): Promise<string | null> {
  try {
    const init = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
      signal: AbortSignal.timeout(LI_TIMEOUT),
    })
    if (!init.ok) {
      console.error(`[linkedin-image] initializeUpload ${init.status}: ${await init.text().catch(() => "")}`)
      return null
    }
    const { value } = (await init.json()) as { value?: { uploadUrl?: string; image?: string } }
    if (!value?.uploadUrl || !value?.image) {
      console.error("[linkedin-image] initializeUpload sem uploadUrl/image")
      return null
    }
    const bytes = await readImageBytes(imageUrl)
    if (!bytes) {
      console.error(`[linkedin-image] sem bytes da imagem (${imageUrl})`)
      return null
    }
    const up = await fetch(value.uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "image/png" },
      body: bytes,
      signal: AbortSignal.timeout(LI_TIMEOUT),
    })
    if (!up.ok) {
      console.error(`[linkedin-image] PUT ${up.status}: ${await up.text().catch(() => "")}`)
      return null
    }
    return value.image
  } catch (e) {
    console.error("[linkedin-image] exceção:", e)
    return null
  }
}

// Sobe o MP4 da peça de motion pro LinkedIn (Videos API: initializeUpload →
// PUT das partes → finalizeUpload) e devolve o URN do vídeo. Best-effort → null
// em qualquer falha (o post sai só com texto). FASE 2: o fluxo segue a doc da
// Videos API; precisa de validação com conta real (upload multipart + ETags).
async function uploadLinkedinVideo(accessToken: string, authorUrn: string, videoUrl: string): Promise<string | null> {
  try {
    const bytes = await readImageBytes(videoUrl) // lê bytes genéricos do R2 (serve p/ MP4)
    if (!bytes) {
      console.error(`[linkedin-video] sem bytes do vídeo (${videoUrl})`)
      return null
    }
    const init = await fetch("https://api.linkedin.com/rest/videos?action=initializeUpload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: authorUrn,
          fileSizeBytes: bytes.byteLength,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
      signal: AbortSignal.timeout(LI_TIMEOUT),
    })
    if (!init.ok) {
      console.error(`[linkedin-video] initializeUpload ${init.status}: ${await init.text().catch(() => "")}`)
      return null
    }
    const { value } = (await init.json()) as {
      value?: {
        video?: string
        uploadToken?: string
        uploadInstructions?: { uploadUrl: string; firstByte: number; lastByte: number }[]
      }
    }
    if (!value?.video || !value.uploadInstructions?.length) {
      console.error("[linkedin-video] initializeUpload sem video/uploadInstructions")
      return null
    }
    const partIds: string[] = []
    for (const ins of value.uploadInstructions) {
      const part = bytes.slice(ins.firstByte, ins.lastByte + 1)
      const up = await fetch(ins.uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/octet-stream" },
        body: part,
        signal: AbortSignal.timeout(60000), // upload de bytes — timeout maior
      })
      if (!up.ok) {
        console.error(`[linkedin-video] PUT ${up.status}: ${await up.text().catch(() => "")}`)
        return null
      }
      const etag = up.headers.get("etag")
      if (etag) partIds.push(etag)
    }
    const fin = await fetch("https://api.linkedin.com/rest/videos?action=finalizeUpload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        finalizeUploadRequest: { video: value.video, uploadToken: value.uploadToken ?? "", uploadedPartIds: partIds },
      }),
      signal: AbortSignal.timeout(LI_TIMEOUT),
    })
    if (!fin.ok) {
      console.error(`[linkedin-video] finalizeUpload ${fin.status}: ${await fin.text().catch(() => "")}`)
      return null
    }
    return value.video
  } catch (e) {
    console.error("[linkedin-video] exceção:", e)
    return null
  }
}

export class LinkedinChannel implements Channel {
  readonly platform: Platform = "linkedin"
  async publish(input: PublishInput, credentials: string | null): Promise<{ url: string }> {
    if (!credentials) throw new Error("linkedin: credenciais ausentes")
    // Aceita JSON {access_token, author_urn?} OU um token cru (o usuário costuma
    // colar só o token).
    let accessToken = ""
    let authorUrn = ""
    try {
      const parsed = JSON.parse(credentials) as { access_token?: string; author_urn?: string }
      accessToken = (parsed.access_token ?? "").trim()
      authorUrn = (parsed.author_urn ?? "").trim()
    } catch {
      accessToken = credentials.trim()
    }
    if (!accessToken) throw new Error("linkedin: access_token ausente")
    if (!authorUrn) authorUrn = await resolveLinkedinAuthor(accessToken)

    // Vídeo (peça de motion) tem precedência; senão a imagem on-brand. Best-effort:
    // se o upload falhar, o post sai só com texto.
    const videoUrn = input.videoUrl ? await uploadLinkedinVideo(accessToken, authorUrn, input.videoUrl) : null
    const imageUrn = !videoUrn && input.imageUrl ? await uploadLinkedinImage(accessToken, authorUrn, input.imageUrl) : null
    const mediaUrn = videoUrn ?? imageUrn

    // API atual (Posts API); a /v2/ugcPosts é legada.
    const res = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: authorUrn,
        commentary: escapeLinkedinText(cap(`${input.title}\n\n${input.body}`, 3000)),
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        ...(mediaUrn ? { content: { media: { id: mediaUrn, title: cap(input.title, 400) } } } : {}),
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
      signal: AbortSignal.timeout(LI_TIMEOUT),
    })
    if (!res.ok) {
      throw new Error(`linkedin posts: ${res.status} ${await res.text().catch(() => "")}`)
    }
    const id = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id") ?? ""
    return { url: id ? `https://www.linkedin.com/feed/update/${id}` : "https://www.linkedin.com/feed/" }
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
      signal: AbortSignal.timeout(20000),
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
      signal: AbortSignal.timeout(20000),
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
        text: cap(input.body, 500),
        ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
        access_token,
      }),
      signal: AbortSignal.timeout(20000),
    })
    if (!create.ok) throw new Error(`threads create: ${create.status}`)
    const { id: creationId } = (await create.json()) as { id: string }
    // 2) publica o container
    const pub = await fetch(`${base}/${user_id}/threads_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: creationId, access_token }),
      signal: AbortSignal.timeout(20000),
    })
    if (!pub.ok) throw new Error(`threads publish: ${pub.status}`)
    const { id } = (await pub.json()) as { id: string }
    return { url: `https://www.threads.net/t/${id}` }
  }
}
