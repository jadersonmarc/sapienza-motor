import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { SignJWT } from "jose"
import { testSql, setupControlPlane, provisionTenant, dropTenants, usage } from "@/lib/testutil"
import { withTenant } from "@/lib/platform/tenancy"
import { decryptSecret } from "@/lib/platform/crypto"
import {
  createItem,
  insertProposedRevision,
  createClipSource,
  createClipItem,
  addRevision,
  saveTranscript,
  setRenderStatus,
  getClipProps,
} from "@/lib/content/store"
import { reserveClipHours } from "@/lib/content/quota"
import type { ClipProps } from "@/lib/content/clip-types"
import type { Sql } from "@/lib/db"

// Testa a camada de API (route handlers) end-to-end: JWT do core → autorização →
// query escopada ao tenant. Invoca os handlers exportados diretamente com um Request.

const dsn = process.env.TEST_DATABASE_URL
const maybe = dsn ? describe : describe.skip

const SECRET = "test-product-jwt-secret"

async function token(tenantId: string, opts: { produto?: string; role?: string; userId?: string } = {}) {
  return new SignJWT({
    uid: opts.userId ?? randomUUID(),
    tid: tenantId,
    produto: opts.produto ?? "motor",
    role: opts.role ?? "owner",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("sapienza-core")
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET))
}

function req(method: string, url: string, tok?: string, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (tok) headers["authorization"] = `Bearer ${tok}`
  return new Request(`http://motor.local${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// Deixa o tenant PRONTO para criar peças: define a identidade (persona) e conecta
// os canais informados. Sem isso, os endpoints de criação bloqueiam (409) — de
// propósito (exigem agente configurado + canal). Devolve o token (owner).
async function readyToCreate(t: string, channels: string[] = ["blog"]): Promise<string> {
  const tok = await token(t)
  const { PUT } = await import("@/app/api/v1/config/route")
  await PUT(req("PUT", "/api/v1/config", tok, { system_prompt: "Marca de teste — escreva de forma clara e específica." }))
  const { POST } = await import("@/app/api/v1/channels/route")
  for (const p of channels) {
    const credentials = p === "webhook" ? JSON.stringify({ url: "https://x", secret: "s" }) : "c"
    await POST(req("POST", "/api/v1/channels", tok, { platform: p, credentials }))
  }
  return tok
}

maybe("motor API", () => {
  let sql: Sql
  beforeAll(async () => {
    process.env.MOTOR_ENC_KEY = Buffer.alloc(32, 7).toString("base64")
    process.env.PRODUCT_JWT_SECRET = SECRET
    process.env.WEBHOOK_SECRET = "cron-secret"
    process.env.DATABASE_URL = dsn
    sql = testSql()
    await setupControlPlane(sql)
  })
  afterAll(async () => {
    await dropTenants(sql)
    await sql.end()
  })

  it("rejeita sem token e com token de outro produto", async () => {
    const t = await provisionTenant(sql, "pro")
    const { GET } = await import("@/app/api/v1/content/route")
    expect((await GET(req("GET", "/api/v1/content"))).status).toBe(401)
    const wrong = await token(t, { produto: "margot" })
    expect((await GET(req("GET", "/api/v1/content", wrong))).status).toBe(403)
  })

  // Antes, `if (claims.produto && claims.produto !== PRODUTO)` deixava passar um
  // token que não trouxesse a claim — sem escopo nenhum.
  it("rejeita token sem a claim produto (escopo obrigatório)", async () => {
    const t = await provisionTenant(sql, "pro")
    const { GET } = await import("@/app/api/v1/content/route")
    const semEscopo = await token(t, { produto: "" })
    expect((await GET(req("GET", "/api/v1/content", semEscopo))).status).toBe(403)
  })

  it("conectar canal exige owner/admin — member recebe 403", async () => {
    const t = await provisionTenant(sql, "pro")
    const { POST } = await import("@/app/api/v1/channels/route")
    const body = { platform: "blog" }

    const member = await POST(req("POST", "/api/v1/channels", await token(t, { role: "member" }), body))
    expect(member.status).toBe(403)

    const admin = await POST(req("POST", "/api/v1/channels", await token(t, { role: "admin" }), body))
    expect(admin.status).toBe(200)
    const owner = await POST(req("POST", "/api/v1/channels", await token(t, { role: "owner" }), body))
    expect(owner.status).toBe(200)
  })

  it("listar canais continua liberado para qualquer membro", async () => {
    const t = await provisionTenant(sql, "pro")
    const { GET } = await import("@/app/api/v1/channels/route")
    const res = await GET(req("GET", "/api/v1/channels", await token(t, { role: "member" })))
    expect(res.status).toBe(200)
  })

  it("limite conta só sociais: cap em 1 social, troca livre; used reflete sociais", async () => {
    const t = await provisionTenant(sql, "start") // limite = 1 canal social
    const { POST, DELETE, GET } = await import("@/app/api/v1/channels/route")
    const tok = await token(t, { role: "owner" })

    // 1º social ok; 2º social barrado (409, cap = 1).
    expect((await POST(req("POST", "/api/v1/channels", tok, { platform: "instagram", credentials: "c" }))).status).toBe(200)
    expect(
      (await POST(req("POST", "/api/v1/channels", tok, { platform: "linkedin", credentials: "tok" }))).status,
    ).toBe(409)
    // Troca livre: desconecta o instagram → libera o slot social.
    expect((await DELETE(req("DELETE", "/api/v1/channels", tok, { platform: "instagram" }))).status).toBe(200)
    expect(
      (await POST(req("POST", "/api/v1/channels", tok, { platform: "linkedin", credentials: "tok" }))).status,
    ).toBe(200)

    const s = (await (await GET(req("GET", "/api/v1/channels", tok))).json()) as {
      used: number
      limit: number
      channels: { platform: string }[]
    }
    expect(s.used).toBe(1) // só o linkedin (social)
    expect(s.limit).toBe(1)
    expect(s.channels.map((c) => c.platform)).toContain("linkedin")
  })

  it("blog/wordpress/webhook não entram na contagem e nunca são barrados", async () => {
    const t = await provisionTenant(sql, "start") // limite = 1 canal social
    const { POST, GET } = await import("@/app/api/v1/channels/route")
    const tok = await token(t, { role: "owner" })

    // Preenche o slot social e ainda assim conecta blog + webhook (não contam).
    expect((await POST(req("POST", "/api/v1/channels", tok, { platform: "instagram", credentials: "c" }))).status).toBe(200)
    expect((await POST(req("POST", "/api/v1/channels", tok, { platform: "blog" }))).status).toBe(200)
    expect(
      (await POST(req("POST", "/api/v1/channels", tok, { platform: "webhook", credentials: JSON.stringify({ url: "https://x", secret: "s" }) }))).status,
    ).toBe(200)

    const s = (await (await GET(req("GET", "/api/v1/channels", tok))).json()) as { used: number }
    expect(s.used).toBe(1) // só o instagram conta, apesar de blog+webhook conectados
  })

  it("catálogo: X/Threads fora de setup.available e conectar responde 400", async () => {
    const t = await provisionTenant(sql, "pro")
    const tok = await token(t, { role: "owner" })
    const { GET: SETUP } = await import("@/app/api/v1/setup/route")
    const { POST } = await import("@/app/api/v1/channels/route")

    const setup = (await (await SETUP(req("GET", "/api/v1/setup", tok))).json()) as {
      available: { platform: string }[]
    }
    const offered = setup.available.map((a) => a.platform)
    expect(offered).toContain("instagram")
    expect(offered).toContain("linkedin")
    expect(offered).toContain("facebook")
    expect(offered).not.toContain("twitter")
    expect(offered).not.toContain("threads")

    // A plataforma existe no enum, mas está fora do catálogo → 400 (não 409/200).
    const res = await POST(req("POST", "/api/v1/channels", tok, { platform: "twitter", credentials: "x" }))
    expect(res.status).toBe(400)
  })

  it("oauth: seam sem app configurado (409); com app + code, conecta o canal", async () => {
    const t = await provisionTenant(sql, "pro")
    const tok = await token(t, { role: "owner" })
    const { GET, POST } = await import("@/app/api/v1/channels/oauth/route")
    const { GET: CHANNELS } = await import("@/app/api/v1/channels/route")

    // Sem envs de app → 409 (o console cai no colar-JSON).
    expect((await GET(req("GET", "/api/v1/channels/oauth?platform=instagram&state=s1", tok))).status).toBe(409)

    // Configura o app Meta + mocka o fluxo Graph do exchange.
    process.env.META_APP_ID = "app123"
    process.env.META_APP_SECRET = "sec"
    process.env.OAUTH_REDIRECT_BASE = "https://console.x.com"
    const fetchMock = vi.fn(async (u: string) => {
      const url = String(u)
      if (url.includes("fb_exchange_token")) return new Response(JSON.stringify({ access_token: "USERLONG", expires_in: 5184000 }), { status: 200 })
      if (url.includes("/oauth/access_token")) return new Response(JSON.stringify({ access_token: "SHORT" }), { status: 200 })
      if (url.includes("/me/accounts")) return new Response(JSON.stringify({ data: [{ id: "PAGE1", access_token: "PAGETOKEN" }] }), { status: 200 })
      if (url.includes("/PAGE1")) return new Response(JSON.stringify({ instagram_business_account: { id: "IG777" } }), { status: 200 })
      return new Response("{}", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)
    try {
      // GET agora devolve a authorize URL.
      const g = (await (await GET(req("GET", "/api/v1/channels/oauth?platform=instagram&state=s1", tok))).json()) as { url: string }
      expect(g.url).toContain("facebook.com")
      // POST troca o code e conecta.
      expect((await POST(req("POST", "/api/v1/channels/oauth", tok, { platform: "instagram", code: "CODE" }))).status).toBe(200)
      const list = (await (await CHANNELS(req("GET", "/api/v1/channels", tok))).json()) as { used: number; channels: { platform: string }[] }
      expect(list.channels.map((c) => c.platform)).toContain("instagram")
      expect(list.used).toBe(1)
    } finally {
      vi.unstubAllGlobals()
      delete process.env.META_APP_ID
      delete process.env.META_APP_SECRET
      delete process.env.OAUTH_REDIRECT_BASE
    }
  })

  it("config: logo_url aceita https e descarta não-https (vídeo do cliente)", async () => {
    const t = await provisionTenant(sql, "pro")
    const tok = await token(t, { role: "owner" })
    const { GET, PUT } = await import("@/app/api/v1/config/route")

    // https é aceito
    expect((await PUT(req("PUT", "/api/v1/config", tok, { logo_url: "https://cdn/logo.png" }))).status).toBe(200)
    let cfg = (await (await GET(req("GET", "/api/v1/config", tok))).json()) as { logo_url: string }
    expect(cfg.logo_url).toBe("https://cdn/logo.png")

    // http (não seguro) é descartado → vazio (cai no monograma)
    expect((await PUT(req("PUT", "/api/v1/config", tok, { logo_url: "http://cdn/x.png" }))).status).toBe(200)
    cfg = (await (await GET(req("GET", "/api/v1/config", tok))).json()) as { logo_url: string }
    expect(cfg.logo_url).toBe("")
  })

  it("desconectar exige owner/admin — member recebe 403", async () => {
    const t = await provisionTenant(sql, "pro")
    const { DELETE } = await import("@/app/api/v1/channels/route")
    const res = await DELETE(req("DELETE", "/api/v1/channels", await token(t, { role: "member" }), { platform: "blog" }))
    expect(res.status).toBe(403)
  })

  it("upload/excluir mídia exige owner/admin — member recebe 403", async () => {
    const t = await provisionTenant(sql, "pro")
    const { POST, DELETE } = await import("@/app/api/v1/media/route")
    const memberTok = await token(t, { role: "member" })
    // requireRole roda antes de checar storage — 403 mesmo sem S3 configurado.
    const up = await POST(req("POST", "/api/v1/media", memberTok, {}))
    expect(up.status).toBe(403)
    const del = await DELETE(req("DELETE", "/api/v1/media?key=social/linkedin/x.png", memberTok))
    expect(del.status).toBe(403)
  })

  it("trocar conta: reconectar sobrescreve a credencial guardada", async () => {
    const t = await provisionTenant(sql, "pro")
    const { POST } = await import("@/app/api/v1/channels/route")
    const tok = await token(t, { role: "owner" })
    await POST(req("POST", "/api/v1/channels", tok, { platform: "linkedin", credentials: "token-A" }))
    await POST(req("POST", "/api/v1/channels", tok, { platform: "linkedin", credentials: "token-B" }))

    const enc = await withTenant(sql, t, async (tx) => {
      const [row] = (await tx`SELECT credentials_enc FROM motor_channels WHERE platform = 'linkedin'`) as unknown as {
        credentials_enc: string
      }[]
      return row.credentials_enc
    })
    expect(decryptSecret(enc)).toBe("token-B")
  })

  it("cota de geração: a criação além do plano responde 409", async () => {
    const t = await provisionTenant(sql, "start") // incluso = 12
    const tok = await readyToCreate(t) // persona + canal (blog) — pré-requisito de criação
    const { POST } = await import("@/app/api/v1/content/route")
    for (let i = 0; i < 12; i++) {
      // Geração roda em background: a criação responde 202 (a cota é debitada síncrono).
      const ok = await POST(req("POST", "/api/v1/content", tok, { prompt: `tema ${i}` }))
      expect(ok.status).toBe(202)
    }
    const blocked = await POST(req("POST", "/api/v1/content", tok, { prompt: "mais um" }))
    expect(blocked.status).toBe(409)
    const data = (await blocked.json()) as { error: string }
    expect(data.error).toMatch(/cota de geração/i)
    expect(await usage(sql, t, "geracao")).toBe(12)
  })

  it("lista somente conteúdo do próprio tenant (isolamento via JWT)", async () => {
    const a = await provisionTenant(sql, "pro")
    const b = await provisionTenant(sql, "pro")
    await withTenant(sql, a, (tx) => createItem(tx, { slug: "do-a", title: "A", bodyMarkdown: "x" }))
    const { GET } = await import("@/app/api/v1/content/route")
    const res = await GET(req("GET", "/api/v1/content", await token(b)))
    expect(res.status).toBe(200)
    const data = (await res.json()) as { items: { slug: string }[] }
    expect(data.items.find((i) => i.slug === "do-a")).toBeUndefined()
  })

  it("cria peça com o format do canal (linkedin)", async () => {
    const t = await provisionTenant(sql)
    const tok = await readyToCreate(t, ["linkedin"]) // persona + canal do formato
    const { POST } = await import("@/app/api/v1/content/route")
    const res = await POST(req("POST", "/api/v1/content", tok, { prompt: "tema de teste", format: "linkedin" }))
    expect(res.status).toBe(202) // criada já; rascunho gerado em background
    const { id } = (await res.json()) as { id: string }

    const { GET } = await import("@/app/api/v1/content/[id]/route")
    const got = await GET(req("GET", `/api/v1/content/${id}`, tok), { params: Promise.resolve({ id }) })
    const detail = (await got.json()) as { format: string; generating: boolean; revision: unknown }
    expect(detail.format).toBe("linkedin")
    // fora de request scope o rascunho é gerado inline → termina generating=false com revisão
    expect(detail.generating).toBe(false)
    expect(detail.revision).not.toBeNull()
  })

  it("bloqueia criar peça sem identidade do agente / sem canal (409)", async () => {
    const t = await provisionTenant(sql, "pro")
    const tok = await token(t) // sem persona e sem canal
    const { POST } = await import("@/app/api/v1/content/route")
    // 1) sem identidade do agente → 409
    let res = await POST(req("POST", "/api/v1/content", tok, { prompt: "x" }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/identidade/i)
    // 2) com identidade, mas ainda sem canal → 409
    const { PUT } = await import("@/app/api/v1/config/route")
    await PUT(req("PUT", "/api/v1/config", tok, { system_prompt: "Marca X" }))
    res = await POST(req("POST", "/api/v1/content", tok, { prompt: "x" }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/canal/i)
  })

  it("motion: bloqueia sem canal de destino (não cria 'para o instagram' sem canal)", async () => {
    const pro = await provisionTenant(sql, "pro")
    const tok = await token(pro)
    const { PUT } = await import("@/app/api/v1/config/route")
    await PUT(req("PUT", "/api/v1/config", tok, { system_prompt: "Marca X" })) // identidade ok, sem canal
    const { POST } = await import("@/app/api/v1/content/motion/route")
    const res = await POST(req("POST", "/api/v1/content/motion", tok, { prompt: "webinar" }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/canal|webhook/i)
  })

  it("motion: capability por plano — start rejeita (403), pro cria (202)", async () => {
    const { POST } = await import("@/app/api/v1/content/motion/route")
    const { GET } = await import("@/app/api/v1/content/[id]/route")

    // Start não tem motion (motion_enabled.start = 0) → 403 de capability.
    const start = await provisionTenant(sql, "start")
    const denied = await POST(
      req("POST", "/api/v1/content/motion", await token(start), { prompt: "convite webinar" }),
    )
    expect(denied.status).toBe(403)

    // Pro cria (202); sem IA o conteúdo cai no fallback (roteiro `story`), render fica 'queued'.
    const pro = await provisionTenant(sql, "pro")
    const proTok = await readyToCreate(pro, ["instagram"]) // persona + destino do vídeo
    const res = await POST(req("POST", "/api/v1/content/motion", proTok, { prompt: "convite webinar" }))
    expect(res.status).toBe(202)
    const { id } = (await res.json()) as { id: string }

    const got = await GET(req("GET", `/api/v1/content/${id}`, proTok), { params: Promise.resolve({ id }) })
    const detail = (await got.json()) as {
      is_motion: boolean
      render_status: string
      motion_preset: string | null
    }
    expect(detail.is_motion).toBe(true)
    expect(detail.render_status).toBe("queued")
    expect(detail.motion_preset).toBe("story")
  })

  it("PUT /content/:id edita → nova revisão atual", async () => {
    const t = await provisionTenant(sql)
    const item = await withTenant(sql, t, (tx) =>
      createItem(tx, { slug: "edita-me", title: "Antigo", bodyMarkdown: "corpo antigo" }),
    )
    const tok = await token(t)
    const { PUT, GET } = await import("@/app/api/v1/content/[id]/route")
    const params = { params: Promise.resolve({ id: item.id }) }

    const res = await PUT(
      req("PUT", `/api/v1/content/${item.id}`, tok, { title: "Novo título", bodyMarkdown: "corpo novo" }),
      params,
    )
    expect(res.status).toBe(200)

    const got = await GET(req("GET", `/api/v1/content/${item.id}`, tok), params)
    const body = (await got.json()) as { revision: { title: string; body_markdown: string } }
    expect(body.revision.title).toBe("Novo título")
    expect(body.revision.body_markdown).toBe("corpo novo")

    // sem título → 400
    const bad = await PUT(req("PUT", `/api/v1/content/${item.id}`, tok, { title: "", bodyMarkdown: "x" }), params)
    expect(bad.status).toBe(400)
  })

  it("propostas de IA: lista → aceita (vira current) → esvazia", async () => {
    const t = await provisionTenant(sql)
    const item = await withTenant(sql, t, (tx) =>
      createItem(tx, { slug: "com-proposta", title: "Original", bodyMarkdown: "corpo original" }),
    )
    // Simula o apply-recommendation inserindo a proposta direto no store (sem IA).
    const propId = await withTenant(sql, t, (tx) =>
      insertProposedRevision(tx, item.id, { title: "Melhorado", bodyMarkdown: "corpo melhorado" }, { recommendation: "melhore o gancho" }),
    )
    const tok = await token(t)
    const idParams = { params: Promise.resolve({ id: item.id }) }
    const pidParams = { params: Promise.resolve({ id: item.id, pid: propId }) }

    const { GET: listProps } = await import("@/app/api/v1/content/[id]/proposals/route")
    const { POST: accept, DELETE: discard } = await import("@/app/api/v1/content/[id]/proposals/[pid]/route")
    const { GET: getContent } = await import("@/app/api/v1/content/[id]/route")

    // Lista → 1 proposta.
    let res = await listProps(req("GET", `/api/v1/content/${item.id}/proposals`, tok), idParams)
    expect(((await res.json()) as { proposals: unknown[] }).proposals.length).toBe(1)

    // Aceita → a peça passa a ter o título proposto.
    res = await accept(req("POST", `/api/v1/content/${item.id}/proposals/${propId}`, tok), pidParams)
    expect(res.status).toBe(200)
    const detail = (await (await getContent(req("GET", `/api/v1/content/${item.id}`, tok), idParams)).json()) as {
      revision: { title: string }
    }
    expect(detail.revision.title).toBe("Melhorado")

    // Não há mais propostas; e aceitar/descartar de novo → 404.
    res = await listProps(req("GET", `/api/v1/content/${item.id}/proposals`, tok), idParams)
    expect(((await res.json()) as { proposals: unknown[] }).proposals.length).toBe(0)
    res = await discard(req("DELETE", `/api/v1/content/${item.id}/proposals/${propId}`, tok), pidParams)
    expect(res.status).toBe(404)
  })

  it("cria peça, transiciona para published e fatura 1 peça", async () => {
    const t = await provisionTenant(sql, "pro")
    const tok = await readyToCreate(t) // persona + canal (blog)
    const create = await import("@/app/api/v1/content/route")
    const post = await create.POST(req("POST", "/api/v1/content", tok, { prompt: "meu tema" }))
    expect(post.status).toBe(202)
    const { id } = (await post.json()) as { id: string }

    const { POST: transition } = await import("@/app/api/v1/content/[id]/transition/route")
    const ctx = { params: Promise.resolve({ id }) }
    const res = await transition(req("POST", `/api/v1/content/${id}/transition`, tok, { to: "published" }), ctx)
    expect(res.status).toBe(200)
    expect(await usage(sql, t, "peca")).toBe(1)
  })

  it("social: PUT salva a legenda editada e GET a devolve", async () => {
    const t = await provisionTenant(sql, "pro")
    const tok = await readyToCreate(t) // persona + canal (blog)
    const create = await import("@/app/api/v1/content/route")
    const post = await create.POST(req("POST", "/api/v1/content", tok, { prompt: "tema social" }))
    const { id } = (await post.json()) as { id: string }

    const social = await import("@/app/api/v1/content/[id]/social/route")
    const ctx = { params: Promise.resolve({ id }) }
    const put = await social.PUT(
      req("PUT", `/api/v1/content/${id}/social`, tok, {
        platform: "instagram",
        body: "Legenda editada à mão",
        hashtags: ["#pme", "crm"],
      }),
      ctx,
    )
    expect(put.status).toBe(200)

    const get = await social.GET(req("GET", `/api/v1/content/${id}/social`, tok), ctx)
    const data = (await get.json()) as { drafts: { platform: string; body: string; hashtags: string[] }[] }
    const ig = data.drafts.find((d) => d.platform === "instagram")!
    expect(ig.body).toBe("Legenda editada à mão")
    expect(ig.hashtags).toEqual(["pme", "crm"]) // # removido, normalizado
  })

  it("cron generate-draft exige secret e IA (503 sem ANTHROPIC_API_KEY)", async () => {
    const { POST } = await import("@/app/api/cron/generate-draft/route")
    const noAuth = await POST(req("POST", "/api/cron/generate-draft"))
    expect(noAuth.status).toBe(401)

    const withSecret = new Request("http://motor.local/api/cron/generate-draft", {
      method: "POST",
      headers: { "x-webhook-secret": "cron-secret", "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    const res = await POST(withSecret) // sem ANTHROPIC_API_KEY no ambiente de teste
    expect(res.status).toBe(503)
  })

  it("clip: rejeita sem token; cria fonte por URL e lista", async () => {
    const t = await provisionTenant(sql, "pro") // clipper_enabled = 1
    const { GET, POST } = await import("@/app/api/v1/content/clip/route")
    const tok = await token(t)

    expect((await POST(req("POST", "/api/v1/content/clip"))).status).toBe(401)
    // URL inválida → 400
    expect((await POST(req("POST", "/api/v1/content/clip", tok, { url: "não-é-url" }))).status).toBe(400)
    // URL válida → 202 e a fonte aparece na lista
    const created = await POST(req("POST", "/api/v1/content/clip", tok, { url: "https://youtu.be/abc123" }))
    expect(created.status).toBe(202)
    const { id } = (await created.json()) as { id: string }
    expect(id).toBeTruthy()

    const list = await GET(req("GET", "/api/v1/content/clip", tok))
    expect(list.status).toBe(200)
    const data = (await list.json()) as { sources: { id: string; kind: string; status: string }[]; quota: { limitMinutes: number } }
    expect(data.sources.some((s) => s.id === id && s.kind === "url" && s.status === "queued")).toBe(true)
    expect(data.quota.limitMinutes).toBe(480) // pro = 8h
  })

  it("clip: member não pode criar (owner/admin)", async () => {
    const t = await provisionTenant(sql, "pro")
    const { POST } = await import("@/app/api/v1/content/clip/route")
    const member = await token(t, { role: "member" })
    expect((await POST(req("POST", "/api/v1/content/clip", member, { url: "https://x/y" }))).status).toBe(403)
  })

  it("clip editor-lite: reajustar in/out re-recorta as palavras e re-enfileira o render", async () => {
    const t = await provisionTenant(sql, "pro")
    const tok = await token(t)
    // Semeia fonte + transcrição + 1 clipe (em in_review) com clip_props.
    const clipId = await withTenant(sql, t, async (tx) => {
      const src = await createClipSource(tx, { kind: "url", origin: "https://v/1" })
      await saveTranscript(tx, {
        sourceId: src.id,
        lang: "pt",
        text: "a b c d",
        words: [
          { text: "a", startMs: 0, endMs: 1000 },
          { text: "b", startMs: 1000, endMs: 2000 },
          { text: "c", startMs: 2000, endMs: 3000 },
          { text: "d", startMs: 3000, endMs: 4000 },
        ],
        expiresAt: new Date(Date.now() + 60 * 86400_000).toISOString(),
      })
      const item = await createClipItem(tx, { slug: "clip-a", aspect: "9x16", sourceId: src.id })
      const props: ClipProps = {
        sourceKey: "clips/raw/x.mp4",
        inMs: 0,
        outMs: 1000,
        aspect: "9x16",
        caption: { position: "bottom" },
        words: [{ text: "a", startMs: 0, endMs: 1000 }],
        brandOn: true,
        score: 80,
      }
      await addRevision(tx, item.id, {
        title: "Clipe A",
        bodyMarkdown: "gancho",
        ai: false,
        clipProps: props as unknown as Record<string, unknown>,
      })
      await tx`UPDATE content_items SET status='in_review', render_status='done' WHERE id=${item.id}`
      return item.id
    })

    const { PATCH } = await import("@/app/api/v1/content/clip/item/[id]/route")
    const res = await PATCH(req("PATCH", `/api/v1/content/clip/item/${clipId}`, tok, { inMs: 1000, outMs: 3000, aspect: "16x9" }), {
      params: Promise.resolve({ id: clipId }),
    })
    expect(res.status).toBe(200)

    const after = await withTenant(sql, t, (tx) => getClipProps(tx, clipId))
    const p = after as unknown as ClipProps
    expect(p.inMs).toBe(1000)
    expect(p.outMs).toBe(3000)
    expect(p.aspect).toBe("16x9")
    // b e c caem em [1000,3000], re-baseados a 0
    expect(p.words).toEqual([
      { text: "b", startMs: 0, endMs: 1000 },
      { text: "c", startMs: 1000, endMs: 2000 },
    ])
    // voltou para a fila de render
    const rs = (await withTenant(sql, t, (tx) => tx`SELECT render_status FROM content_items WHERE id=${clipId}`)) as unknown as {
      render_status: string
    }[]
    expect(rs[0].render_status).toBe("queued")
  })

  it("clip editor-lite: clipe publicado não pode ser reajustado (409)", async () => {
    const t = await provisionTenant(sql, "pro")
    const tok = await token(t)
    const clipId = await withTenant(sql, t, async (tx) => {
      const src = await createClipSource(tx, { kind: "url", origin: "https://v/2" })
      const item = await createClipItem(tx, { slug: "clip-b", aspect: "9x16", sourceId: src.id })
      await addRevision(tx, item.id, { title: "B", bodyMarkdown: "x", ai: false, clipProps: { inMs: 0, outMs: 1000 } })
      await tx`UPDATE content_items SET status='published' WHERE id=${item.id}`
      return item.id
    })
    const { PATCH } = await import("@/app/api/v1/content/clip/item/[id]/route")
    const res = await PATCH(req("PATCH", `/api/v1/content/clip/item/${clipId}`, tok, { aspect: "16x9" }), {
      params: Promise.resolve({ id: clipId }),
    })
    expect(res.status).toBe(409)
  })

  it("clip delete: exclui o clipe (owner/admin); member 403", async () => {
    const t = await provisionTenant(sql, "pro")
    const tok = await token(t)
    const clipId = await withTenant(sql, t, async (tx) => {
      const src = await createClipSource(tx, { kind: "url", origin: "u" })
      const item = await createClipItem(tx, { slug: "cx", aspect: "9x16", sourceId: src.id })
      await addRevision(tx, item.id, { title: "x", bodyMarkdown: "y", ai: false, clipProps: {} })
      return item.id
    })
    const { DELETE } = await import("@/app/api/v1/content/clip/item/[id]/route")
    const member = await token(t, { role: "member" })
    const forbidden = await DELETE(req("DELETE", `/api/v1/content/clip/item/${clipId}`, member), {
      params: Promise.resolve({ id: clipId }),
    })
    expect(forbidden.status).toBe(403)
    const ok = await DELETE(req("DELETE", `/api/v1/content/clip/item/${clipId}`, tok), {
      params: Promise.resolve({ id: clipId }),
    })
    expect(ok.status).toBe(200)
    const rows = (await withTenant(sql, t, (tx) => tx`SELECT count(*)::int AS n FROM content_items WHERE id=${clipId}`)) as unknown as {
      n: number
    }[]
    expect(rows[0].n).toBe(0)
  })

  it("clip source delete: cascata p/ clipes, SEM estorno de horas", async () => {
    const t = await provisionTenant(sql, "pro")
    const tok = await token(t)
    const sourceId = await withTenant(sql, t, async (tx) => {
      const src = await createClipSource(tx, { kind: "url", origin: "v" })
      for (const s of ["c1", "c2"]) {
        const it = await createClipItem(tx, { slug: s, aspect: "9x16", sourceId: src.id })
        await addRevision(tx, it.id, { title: s, bodyMarkdown: "x", ai: false, clipProps: {} })
      }
      return src.id
    })
    await reserveClipHours(sql, t, 30) // custo já incorrido
    const before = await usage(sql, t, "clipper_minutos")
    const { DELETE } = await import("@/app/api/v1/content/clip/[id]/route")
    const res = await DELETE(req("DELETE", `/api/v1/content/clip/${sourceId}`, tok), {
      params: Promise.resolve({ id: sourceId }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { deletedClips: number }).deletedClips).toBe(2)
    const s = (await withTenant(sql, t, (tx) => tx`SELECT count(*)::int AS n FROM clip_sources WHERE id=${sourceId}`)) as unknown as {
      n: number
    }[]
    const c = (await withTenant(
      sql,
      t,
      (tx) => tx`SELECT count(*)::int AS n FROM content_items WHERE is_clip AND clip_source_id=${sourceId}`,
    )) as unknown as { n: number }[]
    expect(s[0].n).toBe(0)
    expect(c[0].n).toBe(0)
    expect(await usage(sql, t, "clipper_minutos")).toBe(before) // horas NÃO estornadas
  })

  it("cron close-approval-window exige secret e promove in_review vencido", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await withTenant(sql, t, (tx) => createItem(tx, { slug: "cron", title: "C", bodyMarkdown: "x" }))
    await withTenant(sql, t, async (tx) => {
      await tx`UPDATE content_items SET status='in_review', review_deadline_at = now() - interval '1 hour' WHERE id=${item.id}`
    })
    const { POST } = await import("@/app/api/cron/close-approval-window/route")

    const noAuth = await POST(req("POST", "/api/cron/close-approval-window"))
    expect(noAuth.status).toBe(401)

    const authedReq = new Request("http://motor.local/api/cron/close-approval-window", {
      method: "POST",
      headers: { "x-webhook-secret": "cron-secret" },
    })
    const res = await POST(authedReq)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { published: number }
    expect(data.published).toBeGreaterThanOrEqual(1)
    expect(await usage(sql, t, "peca")).toBeGreaterThanOrEqual(1)
  })
})
