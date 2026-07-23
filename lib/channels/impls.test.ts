import { describe, it, expect, vi, afterEach } from "vitest"
import { createHmac } from "node:crypto"
import { WordpressChannel, WebhookChannel } from "./impls"

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
