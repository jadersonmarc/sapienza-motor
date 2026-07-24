import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { getItem, getItemWithRevision, setItemImage } from "@/lib/content/store"
import { generateAndStoreCover, isImageConfigured } from "@/lib/brand/social-image"
import { isPublicAssetUrl } from "@/lib/storage/s3"
import type { FormatId } from "@/lib/brand/formats"

export const runtime = "nodejs"

// Formato on-brand por canal da peça (mesma tabela do publish).
const COVER_FORMAT: Record<string, FormatId> = {
  blog: "blog-og",
  linkedin: "li-feed",
  instagram: "ig-feed",
}

// POST /api/v1/content/:id/image — gera a imagem on-brand no formato do canal da
// peça e a grava (content_items.image_url). owner/admin.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })
  if (!isImageConfigured()) return json(503, { error: "storage não configurado" })

  const info = await withTenant(sql, a.tenantId, async (tx) => {
    const item = await getItem(tx, id)
    const rev = await getItemWithRevision(tx, id)
    return item && rev ? { slug: item.slug, pilar: item.pilar, format: item.format, title: rev.title } : null
  })
  if (!info) return json(404, { error: "peça não encontrada" })

  const formatId = COVER_FORMAT[info.format] ?? "ig-feed"
  const url = await generateAndStoreCover(a.tenantId, {
    slug: info.slug,
    title: info.title,
    pilar: info.pilar,
    formatId,
  })
  if (!url) return json(503, { error: "não foi possível gerar a imagem" })
  await withTenant(sql, a.tenantId, (tx) => setItemImage(tx, id, url))
  return json(200, { image_url: url })
}

// PUT /api/v1/content/:id/image — troca por uma imagem da biblioteca (URL do
// proxy de mídia, validada). owner/admin.
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { imageUrl?: string }
  const imageUrl = (body.imageUrl ?? "").trim()
  if (!imageUrl || !isPublicAssetUrl(imageUrl)) return json(400, { error: "imagem inválida" })
  await withTenant(sql, a.tenantId, (tx) => setItemImage(tx, id, imageUrl))
  return json(200, { image_url: imageUrl })
}
