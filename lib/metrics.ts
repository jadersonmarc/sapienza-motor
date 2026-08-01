import type { Sql, Tx } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { decryptSecret } from "@/lib/platform/crypto"
import { currentDay, currentPeriod } from "@/lib/platform/period"
import type { Platform } from "@/lib/channels/types"

// Coleta de métricas de desempenho como SÉRIE TEMPORAL (snapshot diário por
// peça×canal). Seam: sem adapter/creds do canal, é no-op. Só o Instagram tem
// adapter real por ora (Graph insights); os demais entram aqui quando validados
// no Bloco C. O id nativo do post é extraído do post_url que nós geramos.

export type PostMetrics = {
  impressions?: number
  reach?: number
  likes?: number
  comments?: number
  shares?: number
  saves?: number
  clicks?: number
}

export interface MetricsAdapter {
  readonly platform: Platform
  /** Busca as métricas do post (id nativo) via API do canal. null = sem dados. */
  fetchPost(nativeId: string, credentials: string | null): Promise<PostMetrics | null>
}

/** Extrai o id nativo do post a partir do post_url que nós mesmos geramos
 *  (formato determinístico por canal). null se não reconhecer. */
export function parsePostId(platform: Platform, url: string): string | null {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean)
    switch (platform) {
      case "instagram": {
        const i = seg.indexOf("p")
        return (i >= 0 ? seg[i + 1] : seg.at(-1)) ?? null
      }
      case "twitter": {
        const i = seg.indexOf("status")
        return i >= 0 ? (seg[i + 1] ?? null) : null
      }
      case "facebook":
      case "threads":
        return seg.at(-1) ?? null
      case "linkedin":
        // .../feed/update/urn:li:share:9 — o URN é o último segmento. Serve p/
        // reconhecer o post, mas perfil pessoal não expõe métrica por post via API
        // (não há adapter de linkedin — coleta é no-op). Ver CHANNELS.md.
        return seg.at(-1) ?? null
      default:
        return null
    }
  } catch {
    return null
  }
}

class InstagramMetricsAdapter implements MetricsAdapter {
  readonly platform: Platform = "instagram"
  async fetchPost(nativeId: string, credentials: string | null): Promise<PostMetrics | null> {
    if (!credentials) return null
    const { access_token } = JSON.parse(credentials) as { access_token: string }
    const base = "https://graph.facebook.com/v21.0"
    const names = "impressions,reach,likes,comments,shares,saved"
    const res = await fetch(
      `${base}/${nativeId}/insights?metric=${names}&access_token=${encodeURIComponent(access_token)}`,
      { signal: AbortSignal.timeout(20000) },
    )
    if (!res.ok) throw new Error(`instagram insights: ${res.status} ${await res.text().catch(() => "")}`)
    const data = (await res.json()) as { data?: { name: string; values?: { value: number }[] }[] }
    const v = (name: string) => data.data?.find((d) => d.name === name)?.values?.[0]?.value
    return {
      impressions: v("impressions"),
      reach: v("reach"),
      likes: v("likes"),
      comments: v("comments"),
      shares: v("shares"),
      saves: v("saved"),
    }
  }
}

class FacebookMetricsAdapter implements MetricsAdapter {
  readonly platform: Platform = "facebook"
  async fetchPost(nativeId: string, credentials: string | null): Promise<PostMetrics | null> {
    if (!credentials) return null
    const { access_token } = JSON.parse(credentials) as { access_token: string }
    const base = "https://graph.facebook.com/v21.0"
    const tok = encodeURIComponent(access_token)
    // Impressões/alcance vêm dos insights do post; curtidas/comentários/compart. do
    // próprio objeto (summary). Duas chamadas — a de objeto não é insight.
    const [insRes, objRes] = await Promise.all([
      fetch(`${base}/${nativeId}/insights?metric=post_impressions,post_impressions_unique&access_token=${tok}`, {
        signal: AbortSignal.timeout(20000),
      }),
      fetch(`${base}/${nativeId}?fields=likes.summary(true),comments.summary(true),shares&access_token=${tok}`, {
        signal: AbortSignal.timeout(20000),
      }),
    ])
    if (!insRes.ok) throw new Error(`facebook insights: ${insRes.status} ${await insRes.text().catch(() => "")}`)
    if (!objRes.ok) throw new Error(`facebook post: ${objRes.status} ${await objRes.text().catch(() => "")}`)
    const ins = (await insRes.json()) as { data?: { name: string; values?: { value: number }[] }[] }
    const iv = (name: string) => ins.data?.find((d) => d.name === name)?.values?.[0]?.value
    const obj = (await objRes.json()) as {
      likes?: { summary?: { total_count?: number } }
      comments?: { summary?: { total_count?: number } }
      shares?: { count?: number }
    }
    return {
      impressions: iv("post_impressions"),
      reach: iv("post_impressions_unique"),
      likes: obj.likes?.summary?.total_count,
      comments: obj.comments?.summary?.total_count,
      shares: obj.shares?.count,
    }
  }
}

// Registro de adapters. Só canais com coleta real por POST entram aqui; os demais
// são no-op. LinkedIn fica de fora de propósito: post de perfil pessoal não expõe
// métrica por post via API (ver CHANNELS.md) — não fingimos dado.
const ADAPTERS: Partial<Record<Platform, MetricsAdapter>> = {
  instagram: new InstagramMetricsAdapter(),
  facebook: new FacebookMetricsAdapter(),
}

export function metricsAdapterFor(platform: Platform): MetricsAdapter | null {
  return ADAPTERS[platform] ?? null
}

/** Grava (idempotente por dia) o snapshot de métricas de uma peça num canal. */
export async function upsertPostMetrics(
  tx: Tx,
  input: { contentItemId: string; platform: Platform; day: string; metrics: PostMetrics },
): Promise<void> {
  const m = input.metrics
  await tx`
    INSERT INTO post_metrics (content_item_id, platform, day, impressions, reach, likes, comments, shares, saves, clicks, fetched_at)
    VALUES (${input.contentItemId}, ${input.platform}, ${input.day}::date,
            ${m.impressions ?? null}, ${m.reach ?? null}, ${m.likes ?? null}, ${m.comments ?? null},
            ${m.shares ?? null}, ${m.saves ?? null}, ${m.clicks ?? null}, now())
    ON CONFLICT (content_item_id, platform, day) DO UPDATE SET
      impressions = EXCLUDED.impressions, reach = EXCLUDED.reach, likes = EXCLUDED.likes,
      comments = EXCLUDED.comments, shares = EXCLUDED.shares, saves = EXCLUDED.saves,
      clicks = EXCLUDED.clicks, fetched_at = now()
  `
}

type SentPost = { content_item_id: string; platform: Platform; post_url: string }

/** Varre as peças publicadas e coleta as métricas do dia (São Paulo) por canal
 *  que tenha adapter + credencial. Erro numa peça não derruba o lote. */
export async function collectMetrics(
  sql: Sql,
  tenantId: string,
  adapters: (p: Platform) => MetricsAdapter | null = metricsAdapterFor,
  now: Date = new Date(),
): Promise<{ scanned: number; written: number; failures: { itemId: string; platform: string; error: string }[] }> {
  const day = currentDay(now)
  const { posts, credByPlatform } = await withTenant(sql, tenantId, async (tx) => {
    const posts = (await tx`
      SELECT sd.content_item_id, sd.platform, sd.post_url
        FROM social_drafts sd
        JOIN content_items ci ON ci.id = sd.content_item_id
       WHERE sd.status = 'sent' AND sd.post_url IS NOT NULL AND ci.published_at IS NOT NULL
    `) as unknown as SentPost[]
    const ch = (await tx`
      SELECT platform, credentials_enc FROM motor_channels WHERE enabled = true
    `) as unknown as { platform: Platform; credentials_enc: string | null }[]
    const credByPlatform = new Map(ch.map((c) => [c.platform, c.credentials_enc]))
    return { posts, credByPlatform }
  })

  let written = 0
  const failures: { itemId: string; platform: string; error: string }[] = []
  for (const p of posts) {
    const adapter = adapters(p.platform)
    if (!adapter) continue // canal sem coleta (ainda)
    const enc = credByPlatform.get(p.platform)
    if (enc === undefined) continue // canal não conectado
    const nativeId = parsePostId(p.platform, p.post_url)
    if (!nativeId) continue
    try {
      const creds = enc ? decryptSecret(enc) : null
      const metrics = await adapter.fetchPost(nativeId, creds)
      if (!metrics) continue
      await withTenant(sql, tenantId, (tx) =>
        upsertPostMetrics(tx, { contentItemId: p.content_item_id, platform: p.platform, day, metrics }),
      )
      written++
    } catch (e) {
      failures.push({ itemId: p.content_item_id, platform: p.platform, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { scanned: posts.length, written, failures }
}

// ── Stats (envelope compartilhado com a Atendente) ────────────────────────────
export type StatsSeriesRow = {
  day: string
  impressions: number
  reach: number
  likes: number
  comments: number
  shares: number
}
export type StatsEnvelope = {
  period: string
  series: StatsSeriesRow[]
  totals: { impressions: number; reach: number; likes: number; comments: number; shares: number; posts: number }
  byPillar: { pilar: string | null; impressions: number; posts: number }[]
}

/** Série diária + totais + quebra por pilar, para o período (mês São Paulo). */
export async function statsForPeriod(sql: Sql, tenantId: string, period: string): Promise<StatsEnvelope> {
  return withTenant(sql, tenantId, async (tx) => {
    const series = (await tx`
      SELECT to_char(day, 'YYYY-MM-DD') AS day,
             COALESCE(sum(impressions),0)::int AS impressions,
             COALESCE(sum(reach),0)::int AS reach,
             COALESCE(sum(likes),0)::int AS likes,
             COALESCE(sum(comments),0)::int AS comments,
             COALESCE(sum(shares),0)::int AS shares
        FROM post_metrics
       WHERE to_char(day, 'YYYY-MM') = ${period}
       GROUP BY day ORDER BY day
    `) as unknown as StatsSeriesRow[]
    const [tot] = (await tx`
      SELECT COALESCE(sum(impressions),0)::int AS impressions,
             COALESCE(sum(reach),0)::int AS reach,
             COALESCE(sum(likes),0)::int AS likes,
             COALESCE(sum(comments),0)::int AS comments,
             COALESCE(sum(shares),0)::int AS shares,
             COUNT(DISTINCT content_item_id)::int AS posts
        FROM post_metrics WHERE to_char(day, 'YYYY-MM') = ${period}
    `) as unknown as StatsEnvelope["totals"][]
    const byPillar = (await tx`
      SELECT ci.pilar AS pilar,
             COALESCE(sum(pm.impressions),0)::int AS impressions,
             COUNT(DISTINCT pm.content_item_id)::int AS posts
        FROM post_metrics pm JOIN content_items ci ON ci.id = pm.content_item_id
       WHERE to_char(pm.day, 'YYYY-MM') = ${period}
       GROUP BY ci.pilar ORDER BY impressions DESC
    `) as unknown as StatsEnvelope["byPillar"]
    return { period, series, totals: tot, byPillar }
  })
}

export type TopPost = {
  slug: string
  title: string | null
  pilar: string | null
  format: string
  impressions: number
  likes: number
  comments: number
}

/** Melhores posts do período por impressões (junta o título da revisão atual). */
export async function topPostsForPeriod(sql: Sql, tenantId: string, period: string, limit = 5): Promise<TopPost[]> {
  const lim = Math.min(Math.max(1, Math.trunc(limit)), 20)
  return withTenant(sql, tenantId, async (tx) => {
    return (await tx`
      SELECT ci.slug, cr.title AS title, ci.pilar AS pilar, ci.format AS format,
             COALESCE(sum(pm.impressions),0)::int AS impressions,
             COALESCE(sum(pm.likes),0)::int AS likes,
             COALESCE(sum(pm.comments),0)::int AS comments
        FROM post_metrics pm
        JOIN content_items ci ON ci.id = pm.content_item_id
        LEFT JOIN content_revisions cr ON cr.id = ci.current_revision_id
       WHERE to_char(pm.day, 'YYYY-MM') = ${period}
       GROUP BY ci.id, ci.slug, cr.title, ci.pilar, ci.format
       ORDER BY impressions DESC LIMIT ${lim}
    `) as unknown as TopPost[]
  })
}

export type ByConfigRow = {
  config_version: number | null
  posts: number
  impressions: number
  avg_impressions: number
}

/** Desempenho agrupado por config_version — correlaciona COMO a peça foi gerada
 *  (versão da config do agente) com o resultado. */
export async function byConfigForPeriod(sql: Sql, tenantId: string, period: string): Promise<ByConfigRow[]> {
  return withTenant(sql, tenantId, async (tx) => {
    return (await tx`
      SELECT ci.config_version AS config_version,
             COUNT(DISTINCT pm.content_item_id)::int AS posts,
             COALESCE(sum(pm.impressions),0)::int AS impressions,
             COALESCE(round(avg(pm.impressions)),0)::int AS avg_impressions
        FROM post_metrics pm
        JOIN content_items ci ON ci.id = pm.content_item_id
       WHERE to_char(pm.day, 'YYYY-MM') = ${period}
       GROUP BY ci.config_version ORDER BY ci.config_version
    `) as unknown as ByConfigRow[]
  })
}

export { currentPeriod }
