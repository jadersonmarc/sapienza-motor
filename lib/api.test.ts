import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import { SignJWT } from "jose"
import { testSql, setupControlPlane, provisionTenant, dropTenants, usage } from "@/lib/testutil"
import { withTenant } from "@/lib/platform/tenancy"
import { createItem } from "@/lib/content/store"
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

  it("cria peça, transiciona para published e fatura 1 peça", async () => {
    const t = await provisionTenant(sql, "pro")
    const tok = await token(t)
    const create = await import("@/app/api/v1/content/route")
    const post = await create.POST(req("POST", "/api/v1/content", tok, { prompt: "meu tema" }))
    expect(post.status).toBe(201)
    const { id } = (await post.json()) as { id: string }

    const { POST: transition } = await import("@/app/api/v1/content/[id]/transition/route")
    const ctx = { params: Promise.resolve({ id }) }
    const res = await transition(req("POST", `/api/v1/content/${id}/transition`, tok, { to: "published" }), ctx)
    expect(res.status).toBe(200)
    expect(await usage(sql, t, "peca")).toBe(1)
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
