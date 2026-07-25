import { after } from "next/server"
import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { publishItem, PartialPublishError } from "@/lib/channels/registry"
import { assertPublishAllowed, PublishCapError } from "@/lib/content/quota"
import { setPublishError } from "@/lib/content/store"
import { isImageConfigured } from "@/lib/brand/social-image"

export const runtime = "nodejs"

// Lê o essencial da peça (sob withTenant) p/ gerar a capa on-brand antes de publicar.
async function coverInfo(sql: ReturnType<typeof getDb>, tenantId: string, id: string) {
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = (await tx`
      SELECT ci.slug, ci.pilar, ci.format, ci.image_url, ci.published_at, cr.title
        FROM content_items ci
        JOIN content_revisions cr ON cr.id = ci.current_revision_id
       WHERE ci.id = ${id}
    `) as unknown as {
      slug: string
      pilar: string | null
      format: string
      image_url: string | null
      published_at: string | null
      title: string
    }[]
    return row ?? null
  })
}

// POST /api/v1/content/:id/publish — publica em SEGUNDO PLANO e retorna na hora
// (202). O post nos canais (incl. upload de imagem no LinkedIn) roda via after(),
// sem estourar o proxy. Falha no background fica em content_items.publish_error
// (o console mostra); sucesso limpa. A checagem de cota (409) é síncrona.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  // Cota: barra AQUI (síncrono) — não faz sentido iniciar a publicação se o cap
  // não permite. O publishItem checa de novo.
  try {
    await assertPublishAllowed(sql, a.tenantId)
  } catch (e) {
    if (e instanceof PublishCapError) return json(409, { error: e.message })
    throw e
  }

  const body = (await req.json().catch(() => ({}))) as { imageUrl?: string }
  let imageUrl = body.imageUrl
  if (!imageUrl && isImageConfigured()) {
    const info = await coverInfo(sql, a.tenantId, id)
    if (info && info.published_at == null && info.image_url) imageUrl = info.image_url
  }

  // Publica em segundo plano: a request retorna já; o post acontece logo depois.
  after(async () => {
    try {
      await publishItem(sql, a.tenantId, id, undefined, imageUrl)
      await withTenant(sql, a.tenantId, (tx) => setPublishError(tx, id, null))
    } catch (e) {
      const msg =
        e instanceof PartialPublishError ? e.message : e instanceof Error ? e.message : String(e)
      console.error(`[publish] falha em background (peça ${id}):`, msg)
      await withTenant(sql, a.tenantId, (tx) => setPublishError(tx, id, msg)).catch(() => {})
    }
  })

  return json(202, { async: true })
}
