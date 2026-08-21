import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import { testSql, setupControlPlane, provisionTenant, dropTenants, usage } from "@/lib/testutil"
import { withTenant, schemaName, applyTenantMigrations } from "@/lib/platform/tenancy"
import { tenantMigrations } from "@/lib/db/migrations"
import {
  createItem,
  upsertSocialDraft,
  insertAnalysis,
  listAnalyses,
  listItemTitles,
  deleteItem,
  getItem,
  createClipSource,
  createClipItem,
  addRevision,
  setRenderStatus,
  claimNextClip,
  countRenderingClips,
} from "@/lib/content/store"
import { getEditorConfig, upsertEditorConfig, pickBrandBackground } from "@/lib/content/editor-config"
import { contentTransition } from "@/lib/content/transition"
import { regenerate, RegenLimitError } from "@/lib/content/regenerate"
import { connectChannel, publishItem, retryFailedChannels, ChannelLimitError, PartialPublishError, type Drivers } from "@/lib/channels/registry"
import {
  reserveGeneration,
  refundGeneration,
  generationQuota,
  GenerationQuotaError,
  PublishCapError,
  reserveClipHours,
  refundClipHours,
  clipHoursQuota,
  ClipperHoursError,
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

  const newItem = (tenantId: string, slug: string, format?: string) =>
    withTenant(sql, tenantId, (tx) => createItem(tx, { slug, title: "T", bodyMarkdown: "corpo", format }))

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

  // Cota de HORAS do Clipper (SPEC §5.2): limite operacional, verificado na aceitação
  // do job; nunca processa para cobrar depois; sem venda de excedente.
  it("cota de horas: start (2h) aceita 90min, mas o 2º job (total 180>120) é bloqueado", async () => {
    const t = await provisionTenant(sql, "start") // clipper_hours start = 2h = 120min
    await reserveClipHours(sql, t, 90)
    expect(await usage(sql, t, "clipper_minutos")).toBe(90)
    await expect(reserveClipHours(sql, t, 90)).rejects.toThrow(ClipperHoursError)
    expect(await usage(sql, t, "clipper_minutos")).toBe(90) // o bloqueado não debitou
  })

  it("cota de horas: teto acompanha o tier e clipHoursQuota reporta o restante (pro = 8h)", async () => {
    const t = await provisionTenant(sql, "pro") // 8h = 480min
    expect(await clipHoursQuota(sql, t)).toEqual({ usedMinutes: 0, limitMinutes: 480, remainingMinutes: 480 })
    await reserveClipHours(sql, t, 50)
    expect(await clipHoursQuota(sql, t)).toEqual({ usedMinutes: 50, limitMinutes: 480, remainingMinutes: 430 })
  })

  it("cota de horas: falha de ingestão estorna os minutos", async () => {
    const t = await provisionTenant(sql, "pro")
    await reserveClipHours(sql, t, 30)
    expect(await usage(sql, t, "clipper_minutos")).toBe(30)
    await refundClipHours(sql, t, 30)
    expect(await usage(sql, t, "clipper_minutos")).toBe(0)
  })

  // Instrumentação, não fatura: os minutos aparecem em usage_counters mas o metric
  // do plano é 'peca' (o fechamento ignora clipper_minutos).
  it("cota de horas: contada em usage_counters, fora da fatura", async () => {
    const t = await provisionTenant(sql, "pro")
    await reserveClipHours(sql, t, 10)
    expect(await usage(sql, t, "clipper_minutos")).toBe(10)
    expect(await usage(sql, t, "peca")).toBe(0)
  })

  // Escala horizontal do render (Onda 2): o claim atômico garante que réplicas nunca
  // peguem o mesmo clipe; countRenderingClips alimenta o teto por tenant.
  it("clip render: claim atômico entrega cada clipe uma vez; conta os em render", async () => {
    const t = await provisionTenant(sql, "pro")
    const ids = await withTenant(sql, t, async (tx) => {
      const src = await createClipSource(tx, { kind: "url", origin: "u" })
      const out: string[] = []
      for (const slug of ["c1", "c2"]) {
        const item = await createClipItem(tx, { slug, aspect: "9x16", sourceId: src.id })
        await addRevision(tx, item.id, { title: slug, bodyMarkdown: "x", ai: false, clipProps: {} })
        await setRenderStatus(tx, item.id, "queued")
        out.push(item.id)
      }
      return out
    })
    const c1 = await withTenant(sql, t, (tx) => claimNextClip(tx))
    const c2 = await withTenant(sql, t, (tx) => claimNextClip(tx))
    const c3 = await withTenant(sql, t, (tx) => claimNextClip(tx))
    expect(c1?.id && c2?.id && c1.id !== c2.id).toBeTruthy()
    expect(new Set([c1?.id, c2?.id])).toEqual(new Set(ids))
    expect(c3).toBeNull() // fila vazia
    expect(await withTenant(sql, t, (tx) => countRenderingClips(tx))).toBe(2)
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

  it("excluir peça: some e leva revisões/social junto (cascade)", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, `del-${randomUUID()}`)
    await withTenant(sql, t, (tx) => upsertSocialDraft(tx, { itemId: item.id, platform: "linkedin", body: "x", hashtags: [] }))
    const deleted = await withTenant(sql, t, (tx) => deleteItem(tx, item.id))
    expect(deleted).not.toBeNull()
    const gone = await withTenant(sql, t, (tx) => getItem(tx, item.id))
    expect(gone).toBeNull()
    const drafts = (await withTenant(sql, t, (tx) => tx`SELECT count(*)::int AS n FROM social_drafts WHERE content_item_id = ${item.id}`)) as unknown as { n: number }[]
    expect(drafts[0].n).toBe(0)
  })

  it("editor_config: defaults quando vazio; upsert persiste", async () => {
    const t = await provisionTenant(sql, "pro")
    const def = await withTenant(sql, t, (tx) => getEditorConfig(tx))
    expect(def).toEqual({ system_prompt: "", tone: "", themes: [], format: "blog", model: null, enabled: true, cadence_days: 7, handle: "", logo_url: "", caption_style: null, background_keys: [] })

    await withTenant(sql, t, (tx) =>
      upsertEditorConfig(tx, {
        system_prompt: "voz da marca",
        tone: "direto",
        themes: ["automação", "crm"],
        format: "linkedin",
        model: "claude-sonnet-5",
        enabled: false,
        cadence_days: 14,
        handle: "@marca",
        logo_url: "https://cdn/logo.png",
        caption_style: { font: "sans", highlight: "signal" },
        background_keys: ["https://m/api/media/t/editor/a.jpg", "https://m/api/media/t/editor/b.jpg"],
      }),
    )
    const got = await withTenant(sql, t, (tx) => getEditorConfig(tx))
    expect(got.system_prompt).toBe("voz da marca")
    expect(got.themes).toEqual(["automação", "crm"])
    expect(got.format).toBe("linkedin")
    expect(got.enabled).toBe(false)
    expect(got.cadence_days).toBe(14)
    expect(got.logo_url).toBe("https://cdn/logo.png")
    expect(got.handle).toBe("@marca")
    expect(got.caption_style).toEqual({ font: "sans", highlight: "signal" })
    expect(got.background_keys).toHaveLength(2)

    // Rotação determinística: a a b b a → nunca repete consecutivo (2 imagens).
    const a1 = await withTenant(sql, t, (tx) => pickBrandBackground(tx))
    const a2 = await withTenant(sql, t, (tx) => pickBrandBackground(tx))
    const a3 = await withTenant(sql, t, (tx) => pickBrandBackground(tx))
    expect(a1).not.toBe(a2)
    expect(a2).not.toBe(a3)
    expect(a1).toBe(a3) // round-robin com 2 imagens
  })

  it("isolamento: conteúdo não vaza entre tenants", async () => {
    const a = await provisionTenant(sql, "pro")
    const b = await provisionTenant(sql, "pro")
    await newItem(a, "so-do-a")
    const rows = (await withTenant(sql, b, (tx) => tx`SELECT count(*)::int AS n FROM content_items WHERE slug='so-do-a'`)) as unknown as { n: number }[]
    expect(rows[0].n).toBe(0)
  })

  it("publica só nos canais do formato da peça (linkedin não espalha p/ instagram)", async () => {
    const t = await provisionTenant(sql, "pro") // limite 2 canais
    const item = await withTenant(sql, t, (tx) =>
      createItem(tx, { slug: `li-${randomUUID()}`, title: "T", bodyMarkdown: "corpo", format: "linkedin" }),
    )
    await connectChannel(sql, t, "linkedin", "tok")
    await connectChannel(sql, t, "instagram", "tok")
    const li = new MockChannel("linkedin")
    const ig = new MockChannel("instagram")
    const drivers = { linkedin: li, instagram: ig } as unknown as Drivers

    const results = await publishItem(sql, t, item.id, drivers)
    expect(results.map((r) => r.platform)).toEqual(["linkedin"])
    expect(li.published).toHaveLength(1)
    expect(ig.published).toHaveLength(0) // peça linkedin não vaza p/ instagram
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

  it("canais por tier: start (1) bloqueia o 2º SOCIAL; blog não conta", async () => {
    const t = await provisionTenant(sql, "start")
    // blog não entra na contagem: não ocupa o slot social.
    await connectChannel(sql, t, "blog")
    await connectChannel(sql, t, "instagram") // 1º social ok
    await expect(connectChannel(sql, t, "linkedin")).rejects.toBeInstanceOf(ChannelLimitError) // 2º social barrado
  })

  it("publica só nos canais do formato: peça de blog não vaza p/ social", async () => {
    const t = await provisionTenant(sql, "scale") // 3 canais
    const item = await newItem(t, "so-blog") // formato blog (default)
    await connectChannel(sql, t, "blog")
    await connectChannel(sql, t, "instagram", "tok")
    await connectChannel(sql, t, "linkedin", "tok")
    const blog = new MockChannel("blog")
    const ig = new MockChannel("instagram")
    const li = new MockChannel("linkedin")
    const drivers = { blog, instagram: ig, linkedin: li } as unknown as Drivers

    const res = await publishItem(sql, t, item.id, drivers)
    expect(res.map((r) => r.platform)).toEqual(["blog"]) // só o canal de blog
    expect(ig.published).toHaveLength(0)
    expect(li.published).toHaveLength(0)
    expect(await usage(sql, t, "peca")).toBe(1)
  })

  it("retry: reprocessa só o canal que falhou, sem republicar nem re-faturar", async () => {
    const t = await provisionTenant(sql, "scale") // 3 canais
    const item = await withTenant(sql, t, (tx) =>
      createItem(tx, { slug: `retry-${randomUUID()}`, title: "T", bodyMarkdown: "corpo", format: "blog" }),
    )
    await connectChannel(sql, t, "blog")
    await connectChannel(sql, t, "webhook", "creds")

    // 1ª publicação: blog ok, webhook falha → PartialPublishError, mas a peça
    // publica (billing = 1) e webhook fica sem 'sent'.
    const blog = new MockChannel("blog")
    const failing: Channel = {
      platform: "webhook",
      async publish(): Promise<{ url: string }> {
        throw new Error("webhook fora do ar")
      },
    }
    const first = { blog, webhook: failing } as unknown as Drivers
    await expect(publishItem(sql, t, item.id, first)).rejects.toBeInstanceOf(PartialPublishError)
    expect(blog.published).toHaveLength(1)
    expect(await usage(sql, t, "peca")).toBe(1)

    // Estado por canal: webhook fica 'failed' com o erro; blog fica 'sent'.
    const stateAfterFirst = (await withTenant(sql, t, (tx) =>
      tx`SELECT platform, status, last_error FROM social_drafts WHERE content_item_id = ${item.id} ORDER BY platform`,
    )) as unknown as { platform: string; status: string; last_error: string | null }[]
    const webhookRow = stateAfterFirst.find((r) => r.platform === "webhook")!
    expect(webhookRow.status).toBe("failed")
    expect(webhookRow.last_error).toContain("webhook fora do ar")
    expect(stateAfterFirst.find((r) => r.platform === "blog")!.status).toBe("sent")

    // Notificação: emitiu ContentPublishFailed no outbox (o core avisa o cliente).
    const [ev] = (await sql`
      SELECT payload FROM public.event_outbox
       WHERE type = 'ContentPublishFailed' AND tenant_id = ${t}::uuid
    `) as unknown as { payload: { item_id: string; failures: { platform: string }[] } }[]
    expect(ev).toBeTruthy()
    expect(ev.payload.item_id).toBe(item.id)
    expect(ev.payload.failures.map((f) => f.platform)).toEqual(["webhook"])

    // Retry: webhook agora funciona; blog é pulado (já saiu). Não re-fatura.
    const blog2 = new MockChannel("blog")
    const webhook2 = new MockChannel("webhook")
    const retryDrivers = { blog: blog2, webhook: webhook2 } as unknown as Drivers
    const { published, failures } = await retryFailedChannels(sql, t, item.id, retryDrivers)
    expect(failures).toHaveLength(0)
    expect(published.map((p) => p.platform)).toEqual(["webhook"])
    expect(blog2.published).toHaveLength(0) // não republica o que já saiu
    expect(webhook2.published).toHaveLength(1)
    expect(await usage(sql, t, "peca")).toBe(1) // billing intacto

    // Sucesso no retry apaga o 'failed': webhook agora está 'sent', sem falha pendente.
    const stateAfterRetry = (await withTenant(sql, t, (tx) =>
      tx`SELECT status FROM social_drafts WHERE content_item_id = ${item.id} AND platform = 'webhook'`,
    )) as unknown as { status: string }[]
    expect(stateAfterRetry.map((r) => r.status)).toEqual(["sent"])
  })

  it("fan-out: cada canal recebe o aspecto certo (instagram→9x16; webhook→principal)", async () => {
    const t = await provisionTenant(sql, "pro")
    const item = await newItem(t, `mo-${randomUUID()}`, "instagram")
    await withTenant(sql, t, (tx) =>
      tx`UPDATE content_items SET is_motion = true, video_url = 'PRIMARY',
             video_urls = ${tx.json({ "9x16": "V916", "1x1": "V11" })}
           WHERE id = ${item.id}`,
    )
    await connectChannel(sql, t, "instagram", "c")
    await connectChannel(sql, t, "webhook", JSON.stringify({ url: "https://x", secret: "s" }))
    const ig = new MockChannel("instagram")
    const wh = new MockChannel("webhook")
    const drivers = { instagram: ig, webhook: wh } as unknown as Drivers
    await publishItem(sql, t, item.id, drivers)
    expect(ig.published[0].input.videoUrl).toBe("V916") // Instagram → Reels vertical
    expect(wh.published[0].input.videoUrl).toBe("PRIMARY") // webhook → formato principal (sem preferência)
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
    // Dois canais de BLOG (o formato da peça): um publica, o outro falha.
    await connectChannel(sql, t, "blog")
    await connectChannel(sql, t, "webhook", "segredo")
    const bom = new MockChannel("blog")
    const quebrado = new FailingChannel("webhook", "webhook: 500 upstream")
    const drivers = { blog: bom, webhook: quebrado } as unknown as Drivers

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
    // Peça de formato instagram: publishItem só publica nos canais do formato, e a
    // legenda social do IG só é preferida quando a peça de fato vai ao Instagram.
    const item = await newItem(t, "social-pub", "instagram")
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
