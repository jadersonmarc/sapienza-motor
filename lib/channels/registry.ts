import type { Sql } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { channelLimit } from "@/lib/platform/gating"
import { encryptSecret, decryptSecret } from "@/lib/platform/crypto"
import { contentTransition } from "@/lib/content/transition"
import type { Channel, Platform } from "./types"
import { BlogChannel, InstagramChannel, LinkedinChannel } from "./impls"

export type Drivers = Record<Platform, Channel>

export function defaultDrivers(): Drivers {
  return { instagram: new InstagramChannel(), linkedin: new LinkedinChannel(), blog: new BlogChannel() }
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
  // Conteúdo atual + slug + canais, numa leitura tenant-scoped.
  const { slug, title, body, channels } = await withTenant(sql, tenantId, async (tx) => {
    const [item] = (await tx`
      SELECT ci.slug, cr.title, cr.body_markdown
        FROM content_items ci
        JOIN content_revisions cr ON cr.id = ci.current_revision_id
       WHERE ci.id = ${itemId}
    `) as unknown as { slug: string; title: string; body_markdown: string }[]
    if (!item) throw new Error("peça ou revisão não encontrada")
    const channels = (await tx`
      SELECT platform, credentials_enc FROM motor_channels WHERE enabled = true
    `) as unknown as { platform: Platform; credentials_enc: string | null }[]
    return { slug: item.slug, title: item.title, body: item.body_markdown, channels }
  })

  const results: { platform: Platform; url: string }[] = []
  for (const ch of channels) {
    const driver = drivers[ch.platform]
    if (!driver) continue
    const creds = ch.credentials_enc ? decryptSecret(ch.credentials_enc) : null
    const { url } = await driver.publish({ slug, title, body, imageUrl }, creds)
    results.push({ platform: ch.platform, url })
    await withTenant(sql, tenantId, async (tx) => {
      await tx`
        INSERT INTO social_drafts (content_item_id, platform, body, status, image_url, post_url)
        VALUES (${itemId}, ${ch.platform}, ${body}, 'sent', ${imageUrl ?? null}, ${url})
      `
    })
  }

  // Uma peça publicada = 1 unidade faturável (independe de nº de canais).
  await contentTransition(sql, tenantId, itemId, "published")
  return results
}
