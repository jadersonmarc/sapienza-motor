import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { setItemImage } from "@/lib/content/store"
import { generatePieceImage } from "@/lib/content/piece-image"
import { isImageConfigured } from "@/lib/brand/social-image"
import { isPublicAssetUrl } from "@/lib/storage/s3"

export const runtime = "nodejs"

// POST /api/v1/content/:id/image — (re)gera a imagem on-brand no formato do canal
// da peça e a grava. owner/admin. A imagem também nasce sozinha no create/regenerate;
// este endpoint é o "regerar" manual.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })
  if (!isImageConfigured()) return json(503, { error: "storage não configurado" })

  const url = await generatePieceImage(sql, a.tenantId, id)
  if (!url) return json(422, { error: "não foi possível gerar a imagem (peça sem revisão?)" })
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
