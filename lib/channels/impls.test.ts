import { describe, it, expect, vi, afterEach } from "vitest"
import { createHmac } from "node:crypto"
import {
  WordpressChannel,
  WebhookChannel,
  LinkedinChannel,
  InstagramChannel,
  FacebookChannel,
  TwitterChannel,
  ThreadsChannel,
} from "./impls"

// Canais WordPress e Webhook (blog do site do cliente). Mockam o fetch — não
// tocam rede. Verificam auth/HTML (WordPress) e a assinatura HMAC (Webhook).

const input = {
  slug: "minha-peca",
  title: "Minha peça",
  body: "# Título\n\nParágrafo com **negrito**.",
  imageUrl: "https://cdn/x.png",
}

afterEach(() => vi.restoreAllMocks())

describe("WordpressChannel", () => {
  // Roteia as 3 chamadas: baixar a imagem, subir mídia, criar o post.
  function routedFetch(opts: { mediaOk?: boolean } = {}) {
    const { mediaOk = true } = opts
    return vi.fn(async (u: string) => {
      if (u === "https://cdn/x.png")
        return new Response("PNGBYTES", { status: 200, headers: { "content-type": "image/png" } })
      if (u.endsWith("/wp-json/wp/v2/media"))
        return mediaOk ? new Response(JSON.stringify({ id: 99 }), { status: 201 }) : new Response("", { status: 500 })
      if (u.endsWith("/wp-json/wp/v2/posts"))
        return new Response(JSON.stringify({ id: 42, link: "https://cliente.com/minha-peca" }), { status: 201 })
      return new Response("", { status: 404 })
    })
  }

  const creds = JSON.stringify({ site_url: "https://cliente.com/", username: "editor", app_password: "abcd 1234" })

  it("sobe a capa como imagem destacada e posta o HTML com Basic auth", async () => {
    const fetchMock = routedFetch()
    vi.stubGlobal("fetch", fetchMock)

    const { url } = await new WordpressChannel().publish(input, creds)
    expect(url).toBe("https://cliente.com/minha-peca")

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    // mídia enviada com Content-Disposition (nome derivado da slug)
    const media = calls.find(([u]) => u.endsWith("/wp-json/wp/v2/media"))!
    expect((media[1].headers as Record<string, string>)["Content-Disposition"]).toContain('filename="minha-peca.png"')
    // post com auth, HTML e featured_media da capa
    const post = calls.find(([u]) => u.endsWith("/wp-json/wp/v2/posts"))!
    const headers = post[1].headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("editor:abcd 1234").toString("base64")}`)
    const sent = JSON.parse(post[1].body as string)
    expect(sent.status).toBe("publish")
    expect(sent.slug).toBe("minha-peca")
    expect(sent.featured_media).toBe(99)
    expect(sent.content).toContain("<strong>negrito</strong>") // markdown virou HTML
    expect(sent.content).toContain("<h1")
  })

  it("se a capa falhar, publica o texto mesmo assim (sem featured_media)", async () => {
    const fetchMock = routedFetch({ mediaOk: false })
    vi.stubGlobal("fetch", fetchMock)

    const { url } = await new WordpressChannel().publish(input, creds)
    expect(url).toBe("https://cliente.com/minha-peca")
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const post = calls.find(([u]) => u.endsWith("/wp-json/wp/v2/posts"))!
    expect(JSON.parse(post[1].body as string).featured_media).toBeUndefined()
  })

  it("sem credenciais, falha", async () => {
    await expect(new WordpressChannel().publish(input, null)).rejects.toThrow(/credenciais/)
  })
})

describe("LinkedinChannel", () => {
  it("aceita token cru, resolve o autor via userinfo e posta na Posts API atual", async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u === "https://api.linkedin.com/v2/userinfo")
        return new Response(JSON.stringify({ sub: "abc123" }), { status: 200 })
      if (u === "https://api.linkedin.com/rest/posts")
        return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:999" } })
      return new Response("", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)

    // Token CRU (não JSON) — o usuário costuma colar só o token.
    const { url } = await new LinkedinChannel().publish(input, "AQV-token-cru")
    expect(url).toContain("urn:li:share:999")

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const post = calls.find(([u]) => u === "https://api.linkedin.com/rest/posts")!
    const headers = post[1].headers as Record<string, string>
    expect(headers["LinkedIn-Version"]).toBeTruthy()
    expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0")
    const sent = JSON.parse(post[1].body as string)
    expect(sent.author).toBe("urn:li:person:abc123")
    expect(sent.visibility).toBe("PUBLIC")
    expect(sent.lifecycleState).toBe("PUBLISHED")
  })

  it("anexa a imagem on-brand: sobe no /rest/images e referencia em content.media", async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u === "https://api.linkedin.com/v2/userinfo")
        return new Response(JSON.stringify({ sub: "abc123" }), { status: 200 })
      if (u === "https://api.linkedin.com/rest/images?action=initializeUpload")
        return new Response(JSON.stringify({ value: { uploadUrl: "https://upload.li/x", image: "urn:li:image:7" } }), { status: 200 })
      if (u === "https://cdn/x.png") return new Response("PNG", { status: 200 })
      if (u === "https://upload.li/x") return new Response("", { status: 201 })
      if (u === "https://api.linkedin.com/rest/posts")
        return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:1" } })
      return new Response("", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)
    await new LinkedinChannel().publish(input, "tok")
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const post = calls.find(([u]) => u === "https://api.linkedin.com/rest/posts")!
    expect(JSON.parse(post[1].body as string).content.media.id).toBe("urn:li:image:7")
  })

  it("imagem falhando não bloqueia — post sai só com texto", async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u === "https://api.linkedin.com/v2/userinfo")
        return new Response(JSON.stringify({ sub: "abc123" }), { status: 200 })
      if (u === "https://api.linkedin.com/rest/images?action=initializeUpload") return new Response("", { status: 500 })
      if (u === "https://api.linkedin.com/rest/posts")
        return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:2" } })
      return new Response("", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const { url } = await new LinkedinChannel().publish(input, "tok")
    expect(url).toContain("urn:li:share:2")
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(JSON.parse(calls.find(([u]) => u === "https://api.linkedin.com/rest/posts")![1].body as string).content).toBeUndefined()
  })

  it("propaga o erro real (com corpo) da Posts API", async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u === "https://api.linkedin.com/v2/userinfo")
        return new Response(JSON.stringify({ sub: "x" }), { status: 200 })
      return new Response('{"message":"invalid version"}', { status: 400 })
    })
    vi.stubGlobal("fetch", fetchMock)
    await expect(new LinkedinChannel().publish(input, "tok")).rejects.toThrow(/invalid version/)
  })
})

describe("WebhookChannel", () => {
  it("entrega o payload assinado com HMAC-SHA256 do segredo", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ url: "https://site.com/b/minha-peca" }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const secret = "segredo-forte"
    const creds = JSON.stringify({ url: "https://site.com/hooks/sapienza", secret })
    const { url } = await new WebhookChannel().publish(input, creds)

    expect(url).toBe("https://site.com/b/minha-peca")
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe("https://site.com/hooks/sapienza")
    const body = init.body as string
    const header = (init.headers as Record<string, string>)["X-Sapienza-Signature"]
    // A assinatura confere sobre o corpo EXATO enviado.
    const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
    expect(header).toBe(expected)
    const payload = JSON.parse(body)
    expect(payload.slug).toBe("minha-peca")
    expect(payload.body_markdown).toContain("**negrito**") // markdown cru p/ o site do cliente
  })

  it("sem credenciais, falha", async () => {
    await expect(new WebhookChannel().publish(input, null)).rejects.toThrow(/credenciais/)
  })
})

// ── Canais mantidos contra APIs reais: forma do request + propagação de erro.
// Tudo com fetch mockado (não toca rede). Validação contra CONTA real é do usuário
// (runbook em README) — aqui travamos a regressão de forma.

const igCreds = JSON.stringify({ access_token: "tok", account_id: "17800" })

describe("InstagramChannel", () => {
  it("imagem: cria o container e publica (2 chamadas ao Graph)", async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u.endsWith("/17800/media")) return new Response(JSON.stringify({ id: "creation1" }), { status: 200 })
      if (u.endsWith("/17800/media_publish")) return new Response(JSON.stringify({ id: "media9" }), { status: 200 })
      return new Response("", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const { url } = await new InstagramChannel().publish(input, igCreds)
    expect(url).toBe("https://www.instagram.com/p/media9")
    const create = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(([u]) => u.endsWith("/17800/media"))!
    const sent = JSON.parse(create[1].body as string)
    expect(sent.image_url).toBe("https://cdn/x.png")
    expect(sent.access_token).toBe("tok")
  })

  it("Reels (vídeo): media_type REELS, espera FINISHED e publica", async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u.endsWith("/17800/media")) return new Response(JSON.stringify({ id: "c2" }), { status: 200 })
      if (u.includes("/c2?fields=status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 })
      if (u.endsWith("/17800/media_publish")) return new Response(JSON.stringify({ id: "reel3" }), { status: 200 })
      return new Response("", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const { url } = await new InstagramChannel().publish({ ...input, videoUrl: "https://cdn/v.mp4" }, igCreds)
    expect(url).toBe("https://www.instagram.com/p/reel3")
    const create = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(([u]) => u.endsWith("/17800/media"))!
    expect(JSON.parse(create[1].body as string).media_type).toBe("REELS")
  })

  it("propaga erro do Graph (create não-ok)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })))
    await expect(new InstagramChannel().publish(input, igCreds)).rejects.toThrow(/instagram media: 400/)
  })
})

describe("FacebookChannel", () => {
  const creds = JSON.stringify({ access_token: "tok", page_id: "42" })
  it("sem imagem usa /feed; com imagem usa /photos", async () => {
    const feed = vi.fn(async () => new Response(JSON.stringify({ id: "f1" }), { status: 200 }))
    vi.stubGlobal("fetch", feed)
    await new FacebookChannel().publish({ ...input, imageUrl: undefined }, creds)
    expect((feed.mock.calls[0] as unknown as [string])[0]).toContain("/42/feed")

    const photos = vi.fn(async () => new Response(JSON.stringify({ id: "p1", post_id: "42_9" }), { status: 200 }))
    vi.stubGlobal("fetch", photos)
    const { url } = await new FacebookChannel().publish(input, creds)
    expect((photos.mock.calls[0] as unknown as [string])[0]).toContain("/42/photos")
    expect(url).toBe("https://www.facebook.com/42_9")
  })
  it("propaga erro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })))
    await expect(new FacebookChannel().publish(input, creds)).rejects.toThrow(/facebook/)
  })
})

describe("TwitterChannel", () => {
  const creds = JSON.stringify({ access_token: "tok", username: "sapienza" })
  it("corta o texto em 280 e posta", async () => {
    let sentText = ""
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      sentText = JSON.parse(init.body as string).text
      return new Response(JSON.stringify({ data: { id: "99" } }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const long = "a".repeat(500)
    const { url } = await new TwitterChannel().publish({ ...input, body: long }, creds)
    expect(sentText.length).toBe(280)
    expect(url).toBe("https://x.com/sapienza/status/99")
  })
  it("propaga erro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })))
    await expect(new TwitterChannel().publish(input, creds)).rejects.toThrow(/twitter/)
  })
})

describe("ThreadsChannel", () => {
  const creds = JSON.stringify({ access_token: "tok", user_id: "u7" })
  it("cria o container e publica (2 passos)", async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u.endsWith("/u7/threads")) return new Response(JSON.stringify({ id: "cont1" }), { status: 200 })
      if (u.endsWith("/u7/threads_publish")) return new Response(JSON.stringify({ id: "th5" }), { status: 200 })
      return new Response("", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)
    await new ThreadsChannel().publish(input, creds)
    const create = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(([u]) => u.endsWith("/u7/threads"))!
    expect(JSON.parse(create[1].body as string).media_type).toBe("IMAGE")
  })
  it("propaga erro do create", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 400 })))
    await expect(new ThreadsChannel().publish(input, creds)).rejects.toThrow(/threads create: 400/)
  })
})

describe("LinkedinChannel — vídeo (motion)", () => {
  it("sobe o MP4 (initialize→PUT→finalize) e referencia o vídeo em content.media", async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u === "https://api.linkedin.com/v2/userinfo") return new Response(JSON.stringify({ sub: "abc" }), { status: 200 })
      if (u === "https://cdn/v.mp4") return new Response("MP4BYTES", { status: 200 })
      if (u === "https://api.linkedin.com/rest/videos?action=initializeUpload")
        return new Response(
          JSON.stringify({
            value: {
              video: "urn:li:video:7",
              uploadToken: "utk",
              uploadInstructions: [{ uploadUrl: "https://upload.li/v", firstByte: 0, lastByte: 7 }],
            },
          }),
          { status: 200 },
        )
      if (u === "https://upload.li/v") return new Response("", { status: 200, headers: { etag: "et1" } })
      if (u === "https://api.linkedin.com/rest/videos?action=finalizeUpload") return new Response("", { status: 200 })
      if (u === "https://api.linkedin.com/rest/posts")
        return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:9" } })
      return new Response("", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const { url } = await new LinkedinChannel().publish({ ...input, videoUrl: "https://cdn/v.mp4" }, "tok")
    expect(url).toContain("urn:li:share:9")
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls.some(([u]) => u === "https://api.linkedin.com/rest/videos?action=finalizeUpload")).toBe(true)
    const post = calls.find(([u]) => u === "https://api.linkedin.com/rest/posts")!
    expect(JSON.parse(post[1].body as string).content.media.id).toBe("urn:li:video:7")
  })
})
