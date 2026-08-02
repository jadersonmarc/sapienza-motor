import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest"
import { randomUUID } from "node:crypto"
import { testSql, setupControlPlane, provisionTenant, dropTenants } from "@/lib/testutil"
import { withTenant } from "@/lib/platform/tenancy"
import { createItem } from "@/lib/content/store"
import { getEditorConfig, upsertEditorConfig, type EditorConfig } from "@/lib/content/editor-config"
import { connectChannel } from "@/lib/channels/registry"
import {
  collectMetrics,
  statsForPeriod,
  parsePostId,
  upsertPostMetrics,
  topPostsForPeriod,
  byConfigForPeriod,
  metricsAdapterFor,
  collectChannelMetrics,
  channelGrowthForPeriod,
  upsertChannelMetrics,
  type MetricsAdapter,
  type PostMetrics,
  type ChannelMetrics,
} from "@/lib/metrics"
import { currentPeriod, currentDay } from "@/lib/platform/period"
import type { Sql } from "@/lib/db"

// parsePostId é puro — roda sempre.
describe("parsePostId", () => {
  it("extrai o id nativo por canal a partir do post_url que nós geramos", () => {
    expect(parsePostId("instagram", "https://www.instagram.com/p/ABC123")).toBe("ABC123")
    expect(parsePostId("twitter", "https://x.com/sapienza/status/99")).toBe("99")
    expect(parsePostId("facebook", "https://www.facebook.com/42_9")).toBe("42_9")
    expect(parsePostId("linkedin", "https://www.linkedin.com/feed/update/urn:li:share:9")).toBe("urn:li:share:9")
    expect(parsePostId("blog", "https://x/y")).toBeNull()
  })
})

// FacebookMetricsAdapter — puro (fetch mockado). Impressões/alcance dos insights;
// curtidas/comentários/compart. do objeto (summary).
describe("FacebookMetricsAdapter", () => {
  afterEach(() => vi.unstubAllGlobals())
  it("combina insights + objeto num único PostMetrics", async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u.includes("/insights"))
        return new Response(
          JSON.stringify({
            data: [
              { name: "post_impressions", values: [{ value: 500 }] },
              { name: "post_impressions_unique", values: [{ value: 420 }] },
            ],
          }),
          { status: 200 },
        )
      return new Response(
        JSON.stringify({
          likes: { summary: { total_count: 30 } },
          comments: { summary: { total_count: 7 } },
          shares: { count: 4 },
        }),
        { status: 200 },
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    const adapter = metricsAdapterFor("facebook")!
    const m = await adapter.fetchPost("42_9", JSON.stringify({ access_token: "t", page_id: "42" }))
    expect(m).toEqual({ impressions: 500, reach: 420, likes: 30, comments: 7, shares: 4 })
  })

  it("sem credenciais, é no-op (null)", async () => {
    expect(await metricsAdapterFor("facebook")!.fetchPost("42_9", null)).toBeNull()
  })

  it("linkedin não tem adapter (perfil pessoal não expõe métrica por post)", () => {
    expect(metricsAdapterFor("linkedin")).toBeNull()
  })
})

const dsn = process.env.TEST_DATABASE_URL
const maybe = dsn ? describe : describe.skip

maybe("métricas (série temporal)", () => {
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

  const cfg = (over: Partial<EditorConfig>): EditorConfig => ({
    system_prompt: "", tone: "", themes: [], format: "blog", model: null,
    enabled: true, cadence_days: 7, handle: "", ...over,
  })

  it("config_version: carimba na criação e bumpa só quando muda campo de geração", async () => {
    const t = await provisionTenant(sql, "pro")
    await withTenant(sql, t, (tx) => upsertEditorConfig(tx, cfg({ system_prompt: "A" })))
    const i1 = await withTenant(sql, t, (tx) => createItem(tx, { slug: `a-${randomUUID()}`, title: "T", bodyMarkdown: "c" }))
    expect(i1.config_version).toBe(1)

    // muda o prompt → bump
    await withTenant(sql, t, (tx) => upsertEditorConfig(tx, cfg({ system_prompt: "B" })))
    const i2 = await withTenant(sql, t, (tx) => createItem(tx, { slug: `b-${randomUUID()}`, title: "T", bodyMarkdown: "c" }))
    expect(i2.config_version).toBe(2)

    // muda só o enabled (não afeta geração) → NÃO bumpa
    await withTenant(sql, t, (tx) => upsertEditorConfig(tx, cfg({ system_prompt: "B", enabled: false })))
    const [{ config_version: v }] = (await withTenant(sql, t, (tx) =>
      tx`SELECT config_version FROM editor_config WHERE id = true`,
    )) as unknown as { config_version: number }[]
    expect(v).toBe(2)
  })

  const fakeAdapter = (m: PostMetrics): ((p: string) => MetricsAdapter | null) => {
    const a: MetricsAdapter = { platform: "instagram", async fetchPost() { return m } }
    return (p) => (p === "instagram" ? a : null)
  }

  async function publishedItemWithSentDraft(t: string, pilar: string): Promise<string> {
    const item = await withTenant(sql, t, (tx) =>
      createItem(tx, { slug: `ig-${randomUUID()}`, title: "T", bodyMarkdown: "c", format: "instagram", pilar }),
    )
    await withTenant(sql, t, async (tx) => {
      await tx`UPDATE content_items SET published_at = now() WHERE id = ${item.id}`
      await tx`INSERT INTO social_drafts (content_item_id, platform, body, status, post_url)
               VALUES (${item.id}, 'instagram', 'x', 'sent', 'https://www.instagram.com/p/ABC123')`
    })
    return item.id
  }

  it("coleta é idempotente por dia e alimenta o /stats", async () => {
    const t = await provisionTenant(sql, "pro")
    await connectChannel(sql, t, "instagram", "creds")
    await publishedItemWithSentDraft(t, "p1")

    // 1ª coleta
    const r1 = await collectMetrics(sql, t, fakeAdapter({ impressions: 100, reach: 80, likes: 10, comments: 2, shares: 1, saves: 3 }))
    expect(r1.written).toBe(1)

    // 2ª coleta no mesmo dia: NÃO duplica (PK content_item+platform+day), sobrescreve
    const r2 = await collectMetrics(sql, t, fakeAdapter({ impressions: 150, reach: 120, likes: 20, comments: 4, shares: 2, saves: 5 }))
    expect(r2.written).toBe(1)
    const [{ n }] = (await withTenant(sql, t, (tx) => tx`SELECT count(*)::int AS n FROM post_metrics`)) as unknown as { n: number }[]
    expect(n).toBe(1) // um único snapshot do dia

    const stats = await statsForPeriod(sql, t, currentPeriod())
    expect(stats.totals.impressions).toBe(150) // valor sobrescrito, não somado
    expect(stats.totals.posts).toBe(1)
    expect(stats.series).toHaveLength(1)
    expect(stats.byPillar[0]).toMatchObject({ pilar: "p1", posts: 1 })
  })

  it("top posts (ordenado) e by-config (correlaciona geração×resultado)", async () => {
    const t = await provisionTenant(sql, "pro")
    const day = currentDay()

    // Peça A gerada na config v1
    await withTenant(sql, t, (tx) => upsertEditorConfig(tx, cfg({ system_prompt: "v1" })))
    const a = await withTenant(sql, t, (tx) => createItem(tx, { slug: `a-${randomUUID()}`, title: "Post A", bodyMarkdown: "c", format: "instagram", pilar: "p1" }))
    // Peça B gerada na config v2 (bump)
    await withTenant(sql, t, (tx) => upsertEditorConfig(tx, cfg({ system_prompt: "v2" })))
    const b = await withTenant(sql, t, (tx) => createItem(tx, { slug: `b-${randomUUID()}`, title: "Post B", bodyMarkdown: "c", format: "instagram", pilar: "p2" }))

    await withTenant(sql, t, async (tx) => {
      await upsertPostMetrics(tx, { contentItemId: a.id, platform: "instagram", day, metrics: { impressions: 50, likes: 3, comments: 1 } })
      await upsertPostMetrics(tx, { contentItemId: b.id, platform: "instagram", day, metrics: { impressions: 200, likes: 20, comments: 5 } })
    })

    const top = await topPostsForPeriod(sql, t, currentPeriod(), 5)
    expect(top.map((p) => p.title)).toEqual(["Post B", "Post A"]) // B tem mais impressões
    expect(top[0]).toMatchObject({ impressions: 200, pilar: "p2" })

    const byConfig = await byConfigForPeriod(sql, t, currentPeriod())
    expect(byConfig).toHaveLength(2) // v1 e v2
    const v2 = byConfig.find((r) => r.config_version === 2)!
    expect(v2).toMatchObject({ posts: 1, impressions: 200 })
  })

  const fakeAccountAdapter = (m: ChannelMetrics): ((p: string) => MetricsAdapter | null) => {
    const a: MetricsAdapter = { platform: "instagram", async fetchPost() { return null }, async fetchAccount() { return m } }
    return (p) => (p === "instagram" ? a : null)
  }

  it("coleta de conta (channel_metrics) é idempotente por dia", async () => {
    const t = await provisionTenant(sql, "pro")
    await connectChannel(sql, t, "instagram", "creds")

    const r1 = await collectChannelMetrics(sql, t, fakeAccountAdapter({ followers: 1000 }))
    expect(r1.written).toBe(1)
    const r2 = await collectChannelMetrics(sql, t, fakeAccountAdapter({ followers: 1100 }))
    expect(r2.written).toBe(1)
    const rows = (await withTenant(sql, t, (tx) =>
      tx`SELECT followers FROM channel_metrics WHERE platform = 'instagram'`,
    )) as unknown as { followers: number }[]
    expect(rows).toHaveLength(1) // um snapshot do dia
    expect(rows[0].followers).toBe(1100) // sobrescrito, não somado
  })

  it("crescimento: delta de seguidores início→fim por canal", async () => {
    const t = await provisionTenant(sql, "pro")
    const period = currentPeriod()
    await withTenant(sql, t, async (tx) => {
      await upsertChannelMetrics(tx, { platform: "instagram", day: `${period}-01`, metrics: { followers: 1000 } })
      await upsertChannelMetrics(tx, { platform: "instagram", day: `${period}-15`, metrics: { followers: 1200 } })
    })
    const growth = await channelGrowthForPeriod(sql, t, period)
    const ig = growth.find((g) => g.platform === "instagram")!
    expect(ig.series).toHaveLength(2)
    expect(ig.followersStart).toBe(1000)
    expect(ig.followersEnd).toBe(1200)
    expect(ig.delta).toBe(200)
  })
})
