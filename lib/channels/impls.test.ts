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
  it("posta via REST com Basic auth e converte o markdown em HTML", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 42, link: "https://cliente.com/minha-peca" }), { status: 201 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const creds = JSON.stringify({ site_url: "https://cliente.com/", username: "editor", app_password: "abcd 1234" })
    const { url } = await new WordpressChannel().publish(input, creds)

    expect(url).toBe("https://cliente.com/minha-peca")
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe("https://cliente.com/wp-json/wp/v2/posts") // sem barra dupla
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("editor:abcd 1234").toString("base64")}`)
    const sent = JSON.parse(init.body as string)
    expect(sent.status).toBe("publish")
    expect(sent.slug).toBe("minha-peca")
    expect(sent.content).toContain("<strong>negrito</strong>") // markdown virou HTML
    expect(sent.content).toContain("<h1")
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
