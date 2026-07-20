import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import { testSql, setupControlPlane, provisionTenant, dropTenants, usage } from "@/lib/testutil"
import { withTenant, schemaName, applyTenantMigrations } from "@/lib/platform/tenancy"
import { tenantMigrations } from "@/lib/db/migrations"
import { createItem, upsertSocialDraft, insertAnalysis, listAnalyses, listItemTitles } from "@/lib/content/store"
import { contentTransition } from "@/lib/content/transition"
import { regenerate, RegenLimitError } from "@/lib/content/regenerate"
import { connectChannel, publishItem, ChannelLimitError, PartialPublishError, type Drivers } from "@/lib/channels/registry"
import {
  reserveGeneration,
  refundGeneration,
  generationQuota,
  GenerationQuotaError,
  PublishCapError,
} from "@/lib/content/quota"
import { MockChannel } from "@/lib/channels/mock"
import { processOutbox } from "@/lib/provisioning"
import type { Sql } from "@/lib/db"
import type { Channel, Platform, PublishInput } from "@/lib/channels/types"

/** Canal que sempre falha — simula API de rede fora do ar. Conta as tentativas. */
class FailingChannel implements Channel {
  attempts = 0
  constructor(
    readonly platform: Platform,
    private readonly message: string,
  ) {}
  async publish(_input: PublishInput): Promise<{ url: string }> {
    this.attempts++
    throw new Error(this.message)
  }
}

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

  // Regressão de produção: Margot e Motor coabitam o mesmo tenant_<id>. Quando a
  // Margot provisiona primeiro, ela cria schema_migrations do kit (version bigint
  // PK, insere version+name). O Motor usava a MESMA tabela e o INSERT (name) dele
  // deixava version nulo → NOT NULL → provision em restart loop. Agora o Motor tem
  // motor_schema_migrations própria. Sem o fix, applyTenantMigrations rejeita aqui.
  it("provisiona onde a Margot já criou schema_migrations (tabelas de rastreio coexistem)", async () => {
    const tid = randomUUID()
    const schema = schemaName(tid)
    await sql.unsafe(`CREATE SCHEMA "${schema}"`)
    await sql.unsafe(`CREATE TABLE "${schema}".schema_migrations (
      version bigint PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`)
    await sql.unsafe(`INSERT INTO "${schema}".schema_migrations (version, name) VALUES (1, '0001_crm')`)

    await expect(applyTenantMigrations(sql, tid, tenantMigrations())).resolves.toBeUndefined()

    const [content] = (await sql.unsafe(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables
         WHERE table_schema='${schema}' AND table_name='content_items') AS ok`,
    )) as unknown as { ok: boolean }[]
    expect(content.ok).toBe(true) // Motor criou suas tabelas apesar da schema_migrations da Margot

    const [tracked] = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM "${schema}".motor_schema_migrations`,
    )) as unknown as { n: number }[]
    expect(tracked.n).toBeGreaterThan(0) // registrou na tabela PRÓPRIA

    const [margot] = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM "${schema}".schema_migrations WHERE name='0001_crm'`,
    )) as unknown as { n: number }[]
    expect(margot.n).toBe(1) // a tabela da Margot ficou intacta
  })

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

  // Teto de custo: faturamos por peça publicada, mas gerar chama o modelo e antes
  // disto era ilimitado — dava para queimar centenas de chamadas e publicar 12.
  it("cota de geração: start gera 12 e a 13ª é bloqueada", async () => {
    const t = await provisionTenant(sql, "start") // incluso = 12
    for (let i = 0; i < 12; i++) await reserveGeneration(sql, t)
    expect(await usage(sql, t, "geracao")).toBe(12)
    await expect(reserveGeneration(sql, t)).rejects.toThrow(GenerationQuotaError)
    expect(await usage(sql, t, "geracao")).toBe(12) // a bloqueada não debitou
  })

  it("cota de geração: o limite acompanha o tier (pro = 30)", async () => {
    const t = await provisionTenant(sql, "pro")
    expect(await generationQuota(sql, t)).toEqual({ used: 0, limit: 30, remaining: 30 })
    await reserveGeneration(sql, t)
    expect(await generationQuota(sql, t)).toEqual({ used: 1, limit: 30, remaining: 29 })
  })

  // O trigger do core soma count + EXCLUDED.count, então -1 estorna: o cliente não
  // perde cota quando o modelo falha por erro nosso.
  it("cota de geração: falha do modelo estorna a reserva", async () => {
    const t = await provisionTenant(sql, "start")
    await reserveGeneration(sql, t)
    expect(await usage(sql, t, "geracao")).toBe(1)
    await refundGeneration(sql, t)
    expect(await usage(sql, t, "geracao")).toBe(0)
  })

  // A cota é controle de custo, não item de fatura: o fechamento junta
  // usage_counters por uc.metric = plans.metric, e o metric do plano é 'peca'.
  it("cota de geração: contada em usage_counters mas fora da fatura", async () => {
    const t = await provisionTenant(sql, "start")
    await reserveGeneration(sql, t)
    await reserveGeneration(sql, t)
    expect(await usage(sql, t, "geracao")).toBe(2)
    expect(await usage(sql, t, "peca")).toBe(0) // nada a faturar: nada foi publicado
    const rows = (await sql`
      SELECT metric FROM public.usage_counters WHERE tenant_id = ${t}::uuid ORDER BY metric
    `) as unknown as { metric: string }[]
    expect(rows.map((r) => r.metric)).toEqual(["geracao"])
  })

  it("hard_cap: bloqueia publicação ao atingir o incluso, antes de postar no canal", async () => {
    const t = await provisionTenant(sql, "start", { hardCap: true }) // incluso = 12
    await connectChannel(sql, t, "blog")
    const mock = new MockChannel("blog")
    const drivers = { blog: mock } as unknown as Drivers

    // Chega ao incluso publicando de verdade (12 peças).
    for (let i = 0; i < 12; i++) {
      const item = await newItem(t, `cap-${i}`)
      await contentTransition(sql, t, item.id, "published")
    }
    expect(await usage(sql, t, "peca")).toBe(12)

    // A 13ª: barra antes de o canal receber qualquer coisa e não fatura.
    const extra = await newItem(t, "cap-extra")
    await expect(publishItem(sql, t, extra.id, drivers)).rejects.toThrow(PublishCapError)
    expect(mock.published).toHaveLength(0)
    expect(await usage(sql, t, "peca")).toBe(12)
  })

  it("sem hard_cap: excedente publica normalmente (é receita, não bloqueio)", async () => {
    const t = await provisionTenant(sql, "start") // hardCap = false
    for (let i = 0; i < 13; i++) {
      const item = await newItem(t, `over-${i}`)
      await contentTransition(sql, t, item.id, "published")
    }
    expect(await usage(sql, t, "peca")).toBe(13) // 1 acima do incluso, faturado como excedente
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

  it("canais novos: facebook/twitter/threads conectam e publicam (dentro do tier)", async () => {
    const t = await provisionTenant(sql, "scale") // 3 canais
    const item = await newItem(t, "multi-canal")
    await connectChannel(sql, t, "facebook")
    await connectChannel(sql, t, "twitter")
    await connectChannel(sql, t, "threads")
    const mk = (p: "facebook" | "twitter" | "threads") => new MockChannel(p)
    const fb = mk("facebook"), tw = mk("twitter"), th = mk("threads")
    const drivers = { blog: fb, instagram: fb, linkedin: fb, facebook: fb, twitter: tw, threads: th } as unknown as Drivers
    const res = await publishItem(sql, t, item.id, drivers)
    expect(res.map((r) => r.platform).sort()).toEqual(["facebook", "threads", "twitter"])
    expect(await usage(sql, t, "peca")).toBe(1) // uma peça, 3 canais = 1 unidade
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

  // Regressão: o loop de canais publicava um a um e só transicionava no fim, então
  // uma falha no meio deixava published_at NULL com posts já no ar — e o cron
  // repostava nos canais bons a cada ciclo, para sempre.
  it("publishItem: falha parcial não reposta no canal que deu certo nem refatura", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, "falha-parcial")
    await connectChannel(sql, t, "blog")
    await connectChannel(sql, t, "instagram")
    const bom = new MockChannel("blog")
    const quebrado = new FailingChannel("instagram", "instagram: 500 upstream")
    const drivers = { blog: bom, instagram: quebrado, linkedin: bom } as unknown as Drivers

    // Ciclo 1: blog publica, instagram falha → erro parcial, mas a peça já é pública.
    await expect(publishItem(sql, t, item.id, drivers)).rejects.toThrow(PartialPublishError)
    expect(bom.published).toHaveLength(1)
    expect(await usage(sql, t, "peca")).toBe(1) // faturou uma vez, não zero

    // Ciclo 2 (o retry do cron): não pode repostar no blog nem faturar de novo.
    const segundo = await publishItem(sql, t, item.id, drivers)
    expect(bom.published).toHaveLength(1)
    expect(await usage(sql, t, "peca")).toBe(1)
    expect(segundo.map((r) => r.platform)).toEqual(["blog"])
    expect(quebrado.attempts).toBe(1) // já publicada → nem tenta de novo
  })

  it("publishItem: todos os canais falhando não fatura e permite retry completo", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, "falha-total")
    await connectChannel(sql, t, "blog")
    const quebrado = new FailingChannel("blog", "blog: fora do ar")
    const drivers = { blog: quebrado, instagram: quebrado, linkedin: quebrado } as unknown as Drivers

    await expect(publishItem(sql, t, item.id, drivers)).rejects.toThrow(PartialPublishError)
    expect(await usage(sql, t, "peca")).toBe(0) // nada publicado → nada faturado

    // O canal voltou: o retry publica a peça inteira e fatura uma vez.
    const bom = new MockChannel("blog")
    const res = await publishItem(sql, t, item.id, { blog: bom } as unknown as Drivers)
    expect(res).toHaveLength(1)
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

  it("rejeição: in_review → draft grava a nota (audit) e limpa a janela de aprovação", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, "rejeitar")
    await contentTransition(sql, t, item.id, "in_review")
    await contentTransition(sql, t, item.id, "draft", { note: "faltou o CTA" })
    const [row] = (await withTenant(sql, t, (tx) => tx`SELECT status, review_deadline_at FROM content_items WHERE id=${item.id}`)) as unknown as { status: string; review_deadline_at: string | null }[]
    expect(row.status).toBe("draft")
    expect(row.review_deadline_at).toBeNull() // saiu do caminho de auto-publicação
    const audits = (await withTenant(sql, t, (tx) => tx`SELECT note FROM audit_log WHERE content_item_id=${item.id} AND to_status='draft'`)) as unknown as { note: string | null }[]
    expect(audits.some((a) => a.note === "faltou o CTA")).toBe(true)
  })

  it("cron: listItemTitles devolve títulos para a renovação de tema, escopado ao tenant", async () => {
    const a = await provisionTenant(sql, "pro")
    const b = await provisionTenant(sql, "pro")
    await withTenant(sql, a, (tx) => createItem(tx, { slug: "t1", title: "Título A1", bodyMarkdown: "x" }))
    await withTenant(sql, a, (tx) => createItem(tx, { slug: "t2", title: "Título A2", bodyMarkdown: "x" }))
    const titlesA = await withTenant(sql, a, (tx) => listItemTitles(tx))
    const titlesB = await withTenant(sql, b, (tx) => listItemTitles(tx))
    expect(titlesA.sort()).toEqual(["Título A1", "Título A2"])
    expect(titlesB).toEqual([]) // isolado
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
