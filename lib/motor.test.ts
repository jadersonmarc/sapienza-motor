import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import { testSql, setupControlPlane, provisionTenant, dropTenants, usage } from "@/lib/testutil"
import { withTenant, schemaName } from "@/lib/platform/tenancy"
import { createItem, upsertSocialDraft, insertAnalysis, listAnalyses } from "@/lib/content/store"
import { contentTransition } from "@/lib/content/transition"
import { regenerate, RegenLimitError } from "@/lib/content/regenerate"
import { connectChannel, publishItem, ChannelLimitError, type Drivers } from "@/lib/channels/registry"
import { MockChannel } from "@/lib/channels/mock"
import { processOutbox } from "@/lib/provisioning"
import type { Sql } from "@/lib/db"

const dsn = process.env.TEST_DATABASE_URL
const maybe = dsn ? describe : describe.skip

maybe("motor data plane", () => {
  let sql: Sql
  beforeAll(async () => {
    process.env.MOTOR_ENC_KEY = Buffer.alloc(32, 7).toString("base64")
    sql = testSql()
    await setupControlPlane(sql)
  })
  afterAll(async () => {
    await dropTenants(sql)
    await sql.end()
  })

  const newItem = (tenantId: string, slug: string) =>
    withTenant(sql, tenantId, (tx) => createItem(tx, { slug, title: "T", bodyMarkdown: "corpo" }))

  it("billing: publicar fatura 1 peça; republicar não duplica", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, "peca-1")
    await contentTransition(sql, t, item.id, "published")
    expect(await usage(sql, t, "peca")).toBe(1)
    // published → archived → draft → published: published_at já setado → não refatura.
    await contentTransition(sql, t, item.id, "archived")
    await contentTransition(sql, t, item.id, "draft")
    await contentTransition(sql, t, item.id, "published")
    expect(await usage(sql, t, "peca")).toBe(1)
  })

  it("isolamento: conteúdo não vaza entre tenants", async () => {
    const a = await provisionTenant(sql, "pro")
    const b = await provisionTenant(sql, "pro")
    await newItem(a, "so-do-a")
    const rows = (await withTenant(sql, b, (tx) => tx`SELECT count(*)::int AS n FROM content_items WHERE slug='so-do-a'`)) as unknown as { n: number }[]
    expect(rows[0].n).toBe(0)
  })

  it("janela 48h: in_review vencido é promovido a published (silêncio = aprovado)", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, "janela")
    await contentTransition(sql, t, item.id, "in_review")
    await withTenant(sql, t, (tx) => tx`UPDATE content_items SET review_deadline_at = now() - interval '1 hour' WHERE id=${item.id}`)
    const expired = (await withTenant(sql, t, (tx) => tx`SELECT id FROM content_items WHERE status='in_review' AND review_deadline_at <= now()`)) as unknown as { id: string }[]
    for (const e of expired) await contentTransition(sql, t, e.id, "published")
    expect(await usage(sql, t, "peca")).toBe(1)
  })

  it("regeneração: 3ª bloqueada (máx 2)", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, "regen")
    const gen = async () => ({ title: "novo", bodyMarkdown: "novo corpo" })
    await regenerate(sql, t, item.id, gen)
    await regenerate(sql, t, item.id, gen)
    await expect(regenerate(sql, t, item.id, gen)).rejects.toBeInstanceOf(RegenLimitError)
  })

  it("canais por tier: start (1) bloqueia o 2º canal", async () => {
    const t = await provisionTenant(sql, "start")
    await connectChannel(sql, t, "blog")
    await expect(connectChannel(sql, t, "instagram")).rejects.toBeInstanceOf(ChannelLimitError)
  })

  it("publishItem: publica no canal (mock) e fatura 1 peça", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, "pub")
    await connectChannel(sql, t, "blog")
    const mock = new MockChannel("blog")
    const drivers = { blog: mock, instagram: mock, linkedin: mock } as unknown as Drivers
    const res = await publishItem(sql, t, item.id, drivers)
    expect(res).toHaveLength(1)
    expect(mock.published).toHaveLength(1)
    expect(await usage(sql, t, "peca")).toBe(1)
  })

  it("publishItem: republicar é idempotente (não duplica social_drafts nem refatura)", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, "pub-idem")
    await connectChannel(sql, t, "blog")
    const mock = new MockChannel("blog")
    const drivers = { blog: mock, instagram: mock, linkedin: mock } as unknown as Drivers
    await publishItem(sql, t, item.id, drivers)
    const second = await publishItem(sql, t, item.id, drivers)
    expect(second).toHaveLength(1) // retorna o draft já enviado
    expect(mock.published).toHaveLength(1) // não re-postou
    const drafts = (await withTenant(sql, t, (tx) => tx`SELECT count(*)::int AS n FROM social_drafts WHERE content_item_id=${item.id}`)) as unknown as { n: number }[]
    expect(drafts[0].n).toBe(1)
    expect(await usage(sql, t, "peca")).toBe(1)
  })

  it("social: publish prefere a legenda social gerada (body + hashtags) ao markdown", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, "social-pub")
    await connectChannel(sql, t, "instagram")
    await withTenant(sql, t, (tx) =>
      upsertSocialDraft(tx, { itemId: item.id, platform: "instagram", body: "LEGENDA IG", hashtags: ["pme", "crm"] }),
    )
    const mock = new MockChannel("instagram")
    const drivers = { blog: mock, instagram: mock, linkedin: mock } as unknown as Drivers
    await publishItem(sql, t, item.id, drivers)
    expect(mock.published).toHaveLength(1)
    expect(mock.published[0].input.body).toBe("LEGENDA IG\n\n#pme #crm")
  })

  it("análises: insertAnalysis persiste e listAnalyses lê (payload jsonb intacto)", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, "analise")
    await withTenant(sql, t, (tx) =>
      insertAnalysis(tx, { itemId: item.id, type: "seo", payload: { score: 82, notes: ["ok"] }, model: "m" }),
    )
    const rows = await withTenant(sql, t, (tx) => listAnalyses(tx, item.id))
    expect(rows).toHaveLength(1)
    expect((rows[0].payload as { score: number }).score).toBe(82)
    expect(rows[0].type).toBe("seo")
  })

  it("provisioning: SubscriptionActivated{motor} aplica migrations de tenant", async () => {
    const tid = randomUUID()
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName(tid)}"`)
    await sql`INSERT INTO public.subscriptions (tenant_id, produto, tier, status) VALUES (${tid}::uuid,'motor','pro','active')`
    await sql`INSERT INTO public.event_outbox (type, tenant_id, produto, payload)
              VALUES ('SubscriptionActivated', ${tid}::uuid, 'motor', ${JSON.stringify({ produto: "motor" })}::jsonb)`
    await processOutbox(sql)
    const reg = (await sql`SELECT to_regclass(${schemaName(tid) + ".content_items"}) AS t`) as unknown as { t: string | null }[]
    expect(reg[0].t).not.toBeNull()
  })
})
