import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import { testSql, setupControlPlane, provisionTenant, dropTenants } from "@/lib/testutil"
import { withTenant } from "@/lib/platform/tenancy"
import { createItem } from "@/lib/content/store"
import { getEditorConfig, upsertEditorConfig, type EditorConfig } from "@/lib/content/editor-config"
import { connectChannel } from "@/lib/channels/registry"
import { collectMetrics, statsForPeriod, parsePostId, type MetricsAdapter, type PostMetrics } from "@/lib/metrics"
import { currentPeriod } from "@/lib/platform/period"
import type { Sql } from "@/lib/db"

// parsePostId é puro — roda sempre.
describe("parsePostId", () => {
  it("extrai o id nativo por canal a partir do post_url que nós geramos", () => {
    expect(parsePostId("instagram", "https://www.instagram.com/p/ABC123")).toBe("ABC123")
    expect(parsePostId("twitter", "https://x.com/sapienza/status/99")).toBe("99")
    expect(parsePostId("facebook", "https://www.facebook.com/42_9")).toBe("42_9")
    expect(parsePostId("blog", "https://x/y")).toBeNull()
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
})
