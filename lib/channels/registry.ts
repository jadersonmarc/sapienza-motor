import type { Sql } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { channelLimit } from "@/lib/platform/gating"
import { encryptSecret, decryptSecret } from "@/lib/platform/crypto"
import { contentTransition } from "@/lib/content/transition"
import type { Channel, Platform } from "./types"
import {
  BlogChannel,
  InstagramChannel,
  LinkedinChannel,
  FacebookChannel,
  TwitterChannel,
  ThreadsChannel,
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
  }
}

export class ChannelLimitError extends Error {}

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
      platform: string
    }[]
    const already = enabled.some((c) => c.platform === platform)
    if (!already && enabled.length >= limit) {
      throw new ChannelLimitError(`plano permite ${limit} canal(is); desconecte um para adicionar outro`)
    }
    await tx`
      INSERT INTO motor_channels (platform, credentials_enc, enabled)
      VALUES (${platform}, ${enc}, true)
      ON CONFLICT (platform) DO UPDATE
        SET credentials_enc = COALESCE(${enc}, motor_channels.credentials_enc), enabled = true, updated_at = now()
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
  // Conteúdo atual + slug + canais + rascunhos sociais, numa leitura tenant-scoped.
  const { slug, title, body, alreadyPublished, channels, socialByPlatform } = await withTenant(sql, tenantId, async (tx) => {
    const [item] = (await tx`
      SELECT ci.slug, ci.published_at, cr.title, cr.body_markdown
        FROM content_items ci
        JOIN content_revisions cr ON cr.id = ci.current_revision_id
       WHERE ci.id = ${itemId}
    `) as unknown as { slug: string; published_at: string | null; title: string; body_markdown: string }[]
    if (!item) throw new Error("peça ou revisão não encontrada")
    const channels = (await tx`
      SELECT platform, credentials_enc FROM motor_channels WHERE enabled = true
    `) as unknown as { platform: Platform; credentials_enc: string | null }[]
    // Legendas sociais geradas (status draft|approved) — o publish as prefere ao markdown cru.
    const drafts = (await tx`
      SELECT DISTINCT ON (platform) platform, body, hashtags FROM social_drafts
       WHERE content_item_id = ${itemId} AND status IN ('draft','approved')
       ORDER BY platform, created_at DESC
    `) as unknown as { platform: Platform; body: string; hashtags: string[] }[]
    const socialByPlatform = new Map(drafts.map((d) => [d.platform, d]))
    return {
      slug: item.slug,
      title: item.title,
      body: item.body_markdown,
      alreadyPublished: item.published_at != null,
      channels,
      socialByPlatform,
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

  const results: { platform: Platform; url: string }[] = []
  for (const ch of channels) {
    const driver = drivers[ch.platform]
    if (!driver) continue
    const creds = ch.credentials_enc ? decryptSecret(ch.credentials_enc) : null
    const channelBody = bodyFor(ch.platform)
    const { url } = await driver.publish({ slug, title, body: channelBody, imageUrl }, creds)
    results.push({ platform: ch.platform, url })
    await withTenant(sql, tenantId, async (tx) => {
      await tx`
        INSERT INTO social_drafts (content_item_id, platform, body, status, image_url, post_url)
        VALUES (${itemId}, ${ch.platform}, ${channelBody}, 'sent', ${imageUrl ?? null}, ${url})
      `
    })
  }

  // Uma peça publicada = 1 unidade faturável (independe de nº de canais).
  await contentTransition(sql, tenantId, itemId, "published")
  return results
}
