import type { Sql } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { channelLimit } from "@/lib/platform/gating"
import { encryptSecret, decryptSecret } from "@/lib/platform/crypto"
import { contentTransition } from "@/lib/content/transition"
import { emitContentPublishFailed } from "@/lib/platform/events"
import { assertPublishAllowed } from "@/lib/content/quota"
import type { Channel, Platform } from "./types"
import { isCounted } from "./types"
import { isOAuthConfigured, refresh as oauthRefresh } from "./oauth"
import {
  BlogChannel,
  InstagramChannel,
  LinkedinChannel,
  FacebookChannel,
  TwitterChannel,
  ThreadsChannel,
  WordpressChannel,
  WebhookChannel,
} from "./impls"

export type Drivers = Record<Platform, Channel>

export function defaultDrivers(): Drivers {
  return {
    instagram: new InstagramChannel(),
    linkedin: new LinkedinChannel(),
    blog: new BlogChannel(),
    facebook: new FacebookChannel(),
    twitter: new TwitterChannel(),
    threads: new ThreadsChannel(),
    wordpress: new WordpressChannel(),
    webhook: new WebhookChannel(),
  }
}

// Cada formato publica SÓ nos seus canais — a peça não vaza para os outros (um
// artigo de blog não vira post de LinkedIn/Instagram). blog cobre os canais de
// blog do cliente. Formato desconhecido = fallback seguro (todos os conectados).
const PLATFORMS_FOR_FORMAT: Record<string, Platform[]> = {
  blog: ["blog", "wordpress", "webhook"],
  linkedin: ["linkedin"],
  instagram: ["instagram"],
}

/** Formatos cujo canal está conectado no tenant (ordem: blog, linkedin, instagram).
 *  Orienta a automação: sem isto ela criaria "blog" mesmo sem canal de blog. */
export async function connectedFormats(sql: Sql, tenantId: string): Promise<("blog" | "linkedin" | "instagram")[]> {
  const enabled = new Set((await enabledChannels(sql, tenantId)).map((c) => c.platform))
  return (["blog", "linkedin", "instagram"] as const).filter((f) =>
    PLATFORMS_FOR_FORMAT[f].some((p) => enabled.has(p)),
  )
}

export class ChannelLimitError extends Error {}

/**
 * Um ou mais canais falharam, mas a peça foi publicada em pelo menos um.
 *
 * Lançado DEPOIS da transição para `published`: a peça está pública de fato, e o
 * billing é por peça (não por canal), então o estado no banco reflete a
 * realidade. Os canais que falharam não são retentados automaticamente — ficam
 * em `failures` para ação humana. É o preço de não republicar em loop.
 */
export class PartialPublishError extends Error {
  constructor(
    readonly published: { platform: Platform; url: string }[],
    readonly failures: { platform: Platform; error: string }[],
  ) {
    super(`publicado em ${published.length} canal(is); falhou em: ${failures.map((f) => `${f.platform} (${f.error})`).join(", ")}`)
    this.name = "PartialPublishError"
  }
}

// Estado por canal na peça (social_drafts). Um canal tem no máximo uma linha de
// resultado corrente: gravar 'sent' apaga a 'failed' anterior e vice-versa, então o
// que está no banco reflete a realidade atual (não acumula histórico de tentativas).
async function recordSent(
  sql: Sql,
  tenantId: string,
  itemId: string,
  platform: Platform,
  body: string,
  imageUrl: string | undefined,
  url: string,
): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    await tx`DELETE FROM social_drafts WHERE content_item_id = ${itemId} AND platform = ${platform} AND status = 'failed'`
    await tx`
      INSERT INTO social_drafts (content_item_id, platform, body, status, image_url, post_url)
      VALUES (${itemId}, ${platform}, ${body}, 'sent', ${imageUrl ?? null}, ${url})
    `
  })
}

async function recordFailed(
  sql: Sql,
  tenantId: string,
  itemId: string,
  platform: Platform,
  body: string,
  imageUrl: string | undefined,
  error: string,
): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    await tx`DELETE FROM social_drafts WHERE content_item_id = ${itemId} AND platform = ${platform} AND status = 'failed'`
    await tx`
      INSERT INTO social_drafts (content_item_id, platform, body, status, image_url, last_error)
      VALUES (${itemId}, ${platform}, ${body}, 'failed', ${imageUrl ?? null}, ${error})
    `
  })
}

// Emite ContentPublishFailed no outbox (o core notifica o cliente). Best-effort: um
// erro ao notificar não pode mascarar/reverter a falha de publicação que a gerou.
async function notifyPublishFailed(
  sql: Sql,
  tenantId: string,
  itemId: string,
  title: string,
  failures: { platform: Platform; error: string }[],
): Promise<void> {
  try {
    await withTenant(sql, tenantId, (tx) =>
      emitContentPublishFailed(tx, { tenantId, itemId, title, failures }),
    )
  } catch (e) {
    console.error(`[publish] falha ao emitir ContentPublishFailed (peça ${itemId}):`, e)
  }
}

type ChannelRow = { platform: Platform; enabled: boolean; credentials_enc: string | null }

/** Canais habilitados do tenant. */
export async function enabledChannels(sql: Sql, tenantId: string): Promise<ChannelRow[]> {
  return withTenant(sql, tenantId, async (tx) => {
    return (await tx`
      SELECT platform, enabled, credentials_enc FROM motor_channels WHERE enabled = true
    `) as unknown as ChannelRow[]
  })
}

/** Conecta/atualiza um canal, respeitando o nº de canais do tier (start 1/pro 2/scale 3). */
export async function connectChannel(
  sql: Sql,
  tenantId: string,
  platform: Platform,
  credentials?: string,
): Promise<void> {
  const limit = await channelLimit(sql, tenantId)
  const enc = credentials ? encryptSecret(credentials) : null
  await withTenant(sql, tenantId, async (tx) => {
    const enabled = (await tx`SELECT platform FROM motor_channels WHERE enabled = true`) as unknown as {
      platform: Platform
    }[]
    const already = enabled.some((c) => c.platform === platform)
    // Só canais SOCIAIS contam no limite; blog/wordpress/webhook são encanamento
    // (inclusos em todos os planos) e nunca são bloqueados.
    const socialUsed = enabled.filter((c) => isCounted(c.platform)).length
    if (!already && isCounted(platform) && socialUsed >= limit) {
      throw new ChannelLimitError(
        `seu plano permite ${limit} canal(is) social(is). Desconecte um para trocar, ou faça upgrade para conectar mais.`,
      )
    }
    await tx`
      INSERT INTO motor_channels (platform, credentials_enc, enabled)
      VALUES (${platform}, ${enc}, true)
      ON CONFLICT (platform) DO UPDATE
        SET credentials_enc = COALESCE(${enc}, motor_channels.credentials_enc), enabled = true, updated_at = now()
    `
  })
}

/** Conecta/atualiza um canal via OAuth: grava a credencial de trabalho + o ciclo de
 *  vida do token (expiração + material de refresh, cifrado). Respeita o limite de
 *  canais sociais do plano (igual ao connectChannel). Usado pelo callback OAuth e
 *  pelo refresh (que passa `enforceLimit=false`, pois o canal já está conectado). */
export async function storeChannelToken(
  sql: Sql,
  tenantId: string,
  platform: Platform,
  token: { credentials: string; expiresAt: Date | null; refreshToken: string | null },
  enforceLimit = true,
): Promise<void> {
  const limit = await channelLimit(sql, tenantId)
  const credEnc = encryptSecret(token.credentials)
  const refreshEnc = token.refreshToken ? encryptSecret(token.refreshToken) : null
  const expiresAt = token.expiresAt ? token.expiresAt.toISOString() : null
  await withTenant(sql, tenantId, async (tx) => {
    if (enforceLimit) {
      const enabled = (await tx`SELECT platform FROM motor_channels WHERE enabled = true`) as unknown as { platform: Platform }[]
      const already = enabled.some((c) => c.platform === platform)
      const socialUsed = enabled.filter((c) => isCounted(c.platform)).length
      if (!already && isCounted(platform) && socialUsed >= limit) {
        throw new ChannelLimitError(
          `seu plano permite ${limit} canal(is) social(is). Desconecte um para trocar, ou faça upgrade para conectar mais.`,
        )
      }
    }
    await tx`
      INSERT INTO motor_channels (platform, credentials_enc, token_expires_at, refresh_token_enc, enabled)
      VALUES (${platform}, ${credEnc}, ${expiresAt}, ${refreshEnc}, true)
      ON CONFLICT (platform) DO UPDATE
        SET credentials_enc = ${credEnc}, token_expires_at = ${expiresAt},
            refresh_token_enc = ${refreshEnc}, enabled = true, updated_at = now()
    `
  })
}

// Renova o token se estiver perto de expirar (janela de 7 dias). Best-effort: erro
// de refresh loga e segue (o token atual ainda pode estar válido). Só age em canais
// OAuth com material de refresh — o colar-JSON manual (sem refresh) é ignorado.
const REFRESH_WINDOW_MS = 7 * 86400_000

export async function refreshIfNeeded(sql: Sql, tenantId: string, platform: Platform): Promise<void> {
  if (!isOAuthConfigured(platform)) return
  const [row] = (await withTenant(sql, tenantId, (tx) =>
    tx`SELECT token_expires_at, refresh_token_enc FROM motor_channels WHERE platform = ${platform} AND enabled = true`,
  )) as unknown as { token_expires_at: string | null; refresh_token_enc: string | null }[]
  if (!row?.refresh_token_enc || !row.token_expires_at) return
  if (new Date(row.token_expires_at).getTime() - Date.now() > REFRESH_WINDOW_MS) return // ainda longe de expirar
  try {
    const token = await oauthRefresh(platform, decryptSecret(row.refresh_token_enc))
    await storeChannelToken(sql, tenantId, platform, token, false)
    console.log(`[oauth] token de ${platform} renovado (tenant ${tenantId})`)
  } catch (e) {
    console.error(`[oauth] falha ao renovar ${platform} (tenant ${tenantId}):`, e instanceof Error ? e.message : e)
  }
}

/** Renova (se perto de expirar) todos os canais OAuth conectados do tenant. Chamado
 *  antes de publicar/coletar e pelo cron refresh-tokens. */
export async function refreshExpiringChannels(sql: Sql, tenantId: string): Promise<void> {
  const channels = (await withTenant(sql, tenantId, (tx) =>
    tx`SELECT platform FROM motor_channels WHERE enabled = true AND refresh_token_enc IS NOT NULL`,
  )) as unknown as { platform: Platform }[]
  for (const c of channels) await refreshIfNeeded(sql, tenantId, c.platform)
}

/** Desconecta um canal: libera o slot do tier e zera a credencial guardada.
 *  Desabilita (não deleta) — `channelLimit` só conta enabled=true, então o slot
 *  volta; reconectar reusa a linha via ON CONFLICT. Zerar o token evita deixar
 *  credencial antiga parada após a troca de conta. */
export async function disconnectChannel(sql: Sql, tenantId: string, platform: Platform): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    await tx`
      UPDATE motor_channels
         SET enabled = false, credentials_enc = NULL, updated_at = now()
       WHERE platform = ${platform}
    `
  })
}

/** Publica a peça nos canais habilitados e a transiciona para published (fatura 1 peça). */
export async function publishItem(
  sql: Sql,
  tenantId: string,
  itemId: string,
  drivers: Drivers = defaultDrivers(),
  imageUrl?: string,
): Promise<{ platform: Platform; url: string }[]> {
  // Renova tokens OAuth perto de expirar ANTES de ler as credenciais — a leitura
  // abaixo pega o token fresco. Best-effort (não trava a publicação).
  await refreshExpiringChannels(sql, tenantId).catch(() => {})
  // Conteúdo atual + slug + canais + rascunhos sociais, numa leitura tenant-scoped.
  const { slug, title, body, videoUrl, alreadyPublished, channels, socialByPlatform, sentPlatforms } = await withTenant(sql, tenantId, async (tx) => {
    const [item] = (await tx`
      SELECT ci.slug, ci.format, ci.is_motion, ci.video_url, ci.published_at, cr.title, cr.body_markdown
        FROM content_items ci
        JOIN content_revisions cr ON cr.id = ci.current_revision_id
       WHERE ci.id = ${itemId}
    `) as unknown as {
      slug: string
      format: string
      is_motion: boolean
      video_url: string | null
      published_at: string | null
      title: string
      body_markdown: string
    }[]
    if (!item) throw new Error("peça ou revisão não encontrada")
    // Peça de MOTION (vídeo): publica no canal nativo do formato (Instagram Reels /
    // LinkedIn vídeo) E no Webhook, se conectados — cada canal usa videoUrl. Peça
    // normal: só nos canais do formato (não vaza para os outros).
    const allowed = item.is_motion
      ? ([item.format, "webhook"] as Platform[])
      : PLATFORMS_FOR_FORMAT[item.format]
    const allChannels = (await tx`
      SELECT platform, credentials_enc FROM motor_channels WHERE enabled = true
    `) as unknown as { platform: Platform; credentials_enc: string | null }[]
    const channels = allowed ? allChannels.filter((c) => allowed.includes(c.platform)) : allChannels
    // Legendas sociais geradas (status draft|approved) — o publish as prefere ao markdown cru.
    const drafts = (await tx`
      SELECT DISTINCT ON (platform) platform, body, hashtags FROM social_drafts
       WHERE content_item_id = ${itemId} AND status IN ('draft','approved')
       ORDER BY platform, created_at DESC
    `) as unknown as { platform: Platform; body: string; hashtags: string[] }[]
    const socialByPlatform = new Map(drafts.map((d) => [d.platform, d]))
    // Canais onde esta peça JÁ saiu numa tentativa anterior. `published_at` só é
    // gravado no fim, então sem esta leitura um erro no meio do loop faria o
    // retry repostar nos canais que deram certo.
    const sent = (await tx`
      SELECT platform, post_url FROM social_drafts
       WHERE content_item_id = ${itemId} AND status = 'sent'
    `) as unknown as { platform: Platform; post_url: string | null }[]
    return {
      slug: item.slug,
      title: item.title,
      body: item.body_markdown,
      videoUrl: item.video_url ?? undefined,
      alreadyPublished: item.published_at != null,
      channels,
      socialByPlatform,
      sentPlatforms: new Map(sent.map((s) => [s.platform, s.post_url])),
    }
  })

  // Corpo por canal: IG/LinkedIn preferem a legenda social gerada (body + hashtags);
  // o blog usa o markdown. Sem rascunho social, todos caem no markdown.
  const bodyFor = (platform: Platform): string => {
    const d = socialByPlatform.get(platform)
    if (!d) return body
    const tags = (d.hashtags ?? []).map((h) => `#${h}`).join(" ")
    return tags ? `${d.body}\n\n${tags}` : d.body
  }

  // Idempotente: uma peça já publicada não re-posta nos canais nem duplica
  // social_drafts (o billing já tem guard em published_at). Retorna o que foi enviado.
  if (alreadyPublished) {
    return withTenant(sql, tenantId, async (tx) => {
      const rows = (await tx`
        SELECT platform, post_url FROM social_drafts
         WHERE content_item_id = ${itemId} AND status = 'sent' AND post_url IS NOT NULL
      `) as unknown as { platform: Platform; post_url: string }[]
      return rows.map((r) => ({ platform: r.platform, url: r.post_url }))
    })
  }

  // Cap rígido: barra AQUI, antes de qualquer canal receber post. Dentro do
  // contentTransition seria tarde — o post externo é irreversível. Republicação
  // (acima) não passa por aqui: não posta nem fatura de novo.
  await assertPublishAllowed(sql, tenantId)

  const results: { platform: Platform; url: string }[] = []
  const failures: { platform: Platform; error: string }[] = []
  for (const ch of channels) {
    const driver = drivers[ch.platform]
    if (!driver) continue
    // Já saiu numa tentativa anterior: nunca republicar (o post lá é definitivo).
    const previous = sentPlatforms.get(ch.platform)
    if (previous !== undefined) {
      if (previous) results.push({ platform: ch.platform, url: previous })
      continue
    }
    const creds = ch.credentials_enc ? decryptSecret(ch.credentials_enc) : null
    const channelBody = bodyFor(ch.platform)
    try {
      const { url } = await driver.publish({ slug, title, body: channelBody, imageUrl, videoUrl }, creds)
      results.push({ platform: ch.platform, url })
      await recordSent(sql, tenantId, itemId, ch.platform, channelBody, imageUrl, url)
    } catch (e) {
      // Um canal fora do ar não pode impedir a transição dos que publicaram —
      // sem isto a peça ficaria com published_at NULL e o cron a repostaria nos
      // canais bem-sucedidos a cada ciclo, indefinidamente.
      const error = e instanceof Error ? e.message : String(e)
      failures.push({ platform: ch.platform, error })
      await recordFailed(sql, tenantId, itemId, ch.platform, channelBody, imageUrl, error)
    }
  }

  // Todos os canais falharam: nada foi publicado, então não transiciona nem
  // fatura — o retry do cron tenta a peça inteira de novo. (Sem canal algum
  // habilitado não é falha: a peça publica e fatura, como sempre fez.)
  if (results.length === 0 && failures.length > 0) {
    await notifyPublishFailed(sql, tenantId, itemId, title, failures)
    throw new PartialPublishError([], failures)
  }

  // Uma peça publicada = 1 unidade faturável (independe de nº de canais).
  await contentTransition(sql, tenantId, itemId, "published")
  if (failures.length > 0) {
    await notifyPublishFailed(sql, tenantId, itemId, title, failures)
    throw new PartialPublishError(results, failures)
  }
  return results
}

/** A peça ainda não foi publicada — reprocesso de canais não se aplica. */
export class NotPublishedError extends Error {
  constructor() {
    super("peça ainda não foi publicada")
    this.name = "NotPublishedError"
  }
}

/**
 * Reprocessa APENAS os canais que ainda não receberam esta peça (falharam numa
 * publicação anterior). Para peça JÁ publicada: não transiciona nem fatura de novo
 * (billing é por peça) e nunca republica onde já saiu (`status='sent'`). Retorna o
 * que saiu agora e o que ainda falhou — o chamador atualiza publish_error.
 * A leitura espelha a do publishItem (mesmas tabelas/regras de roteamento).
 */
export async function retryFailedChannels(
  sql: Sql,
  tenantId: string,
  itemId: string,
  drivers: Drivers = defaultDrivers(),
  imageUrl?: string,
): Promise<{ published: { platform: Platform; url: string }[]; failures: { platform: Platform; error: string }[] }> {
  const ctx = await withTenant(sql, tenantId, async (tx) => {
    const [item] = (await tx`
      SELECT ci.slug, ci.format, ci.is_motion, ci.video_url, ci.published_at, cr.title, cr.body_markdown
        FROM content_items ci
        JOIN content_revisions cr ON cr.id = ci.current_revision_id
       WHERE ci.id = ${itemId}
    `) as unknown as {
      slug: string
      format: string
      is_motion: boolean
      video_url: string | null
      published_at: string | null
      title: string
      body_markdown: string
    }[]
    if (!item) throw new Error("peça ou revisão não encontrada")
    if (item.published_at == null) throw new NotPublishedError()
    const allowed = item.is_motion
      ? ([item.format, "webhook"] as Platform[])
      : PLATFORMS_FOR_FORMAT[item.format]
    const allChannels = (await tx`
      SELECT platform, credentials_enc FROM motor_channels WHERE enabled = true
    `) as unknown as { platform: Platform; credentials_enc: string | null }[]
    const channels = allowed ? allChannels.filter((c) => allowed.includes(c.platform)) : allChannels
    const drafts = (await tx`
      SELECT DISTINCT ON (platform) platform, body, hashtags FROM social_drafts
       WHERE content_item_id = ${itemId} AND status IN ('draft','approved')
       ORDER BY platform, created_at DESC
    `) as unknown as { platform: Platform; body: string; hashtags: string[] }[]
    const sent = (await tx`
      SELECT platform FROM social_drafts WHERE content_item_id = ${itemId} AND status = 'sent'
    `) as unknown as { platform: Platform }[]
    return {
      slug: item.slug,
      title: item.title,
      body: item.body_markdown,
      videoUrl: item.video_url ?? undefined,
      channels,
      socialByPlatform: new Map(drafts.map((d) => [d.platform, d])),
      sentSet: new Set(sent.map((s) => s.platform)),
    }
  })

  const bodyFor = (platform: Platform): string => {
    const d = ctx.socialByPlatform.get(platform)
    if (!d) return ctx.body
    const tags = (d.hashtags ?? []).map((h) => `#${h}`).join(" ")
    return tags ? `${d.body}\n\n${tags}` : d.body
  }

  const published: { platform: Platform; url: string }[] = []
  const failures: { platform: Platform; error: string }[] = []
  for (const ch of ctx.channels) {
    const driver = drivers[ch.platform]
    if (!driver) continue
    if (ctx.sentSet.has(ch.platform)) continue // já saiu antes — nunca republica
    const creds = ch.credentials_enc ? decryptSecret(ch.credentials_enc) : null
    const channelBody = bodyFor(ch.platform)
    try {
      const { url } = await driver.publish(
        { slug: ctx.slug, title: ctx.title, body: channelBody, imageUrl, videoUrl: ctx.videoUrl },
        creds,
      )
      published.push({ platform: ch.platform, url })
      await recordSent(sql, tenantId, itemId, ch.platform, channelBody, imageUrl, url)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      failures.push({ platform: ch.platform, error })
      await recordFailed(sql, tenantId, itemId, ch.platform, channelBody, imageUrl, error)
    }
  }
  return { published, failures }
}
