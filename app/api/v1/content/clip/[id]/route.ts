import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { clip4kEnabled } from "@/lib/platform/gating"
import { getClipSource, listClipsForSource, deleteItem, deleteClipSource } from "@/lib/content/store"
import { deleteObject } from "@/lib/storage/s3"
import { clipVideoKey } from "@/lib/storage/keys"

export const runtime = "nodejs"

// GET /api/v1/content/clip/[id] — detalhe da fonte + seus clipes (grade ranqueada).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  const { source, clips } = await withTenant(sql, a.tenantId, async (tx) => ({
    source: await getClipSource(tx, id),
    clips: await listClipsForSource(tx, id),
  }))
  if (!source) return json(404, { error: "fonte não encontrada" })
  // Grade ordenada por score (melhores momentos primeiro).
  clips.sort((x, y) => (y.score ?? 0) - (x.score ?? 0))
  const can4k = await clip4kEnabled(sql, a.tenantId)
  return json(200, { source, clips, can4k })
}

// DELETE /api/v1/content/clip/[id] — exclui o VÍDEO-FONTE em cascata: todos os clipes
// derivados (registro + MP4 no R2), o vídeo-fonte bruto no R2 e a fonte (transcrição
// cai por cascade). Exclusão LOCAL (clipes publicados permanecem na rede). Cota de
// horas/peça NÃO estorna; nada é emitido no outbox. Sem desfazer. owner/admin.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const { id } = await ctx.params
  const sql = getDb()

  const { source, clips } = await withTenant(sql, a.tenantId, async (tx) => ({
    source: await getClipSource(tx, id),
    clips: await listClipsForSource(tx, id),
  }))
  if (!source) return json(404, { error: "vídeo não encontrado" })

  // Clipes derivados: registro (cascade) + MP4 no R2.
  for (const c of clips) {
    await withTenant(sql, a.tenantId, (tx) => deleteItem(tx, c.id))
    await deleteObject(a.tenantId, clipVideoKey({ slug: c.slug })).catch(() => {})
  }
  // Vídeo-fonte bruto (se ainda no R2) + a fonte (cascade da transcrição).
  if (source.r2_key_raw) await deleteObject(a.tenantId, source.r2_key_raw).catch(() => {})
  await withTenant(sql, a.tenantId, (tx) => deleteClipSource(tx, id))
  return json(200, { ok: true, deletedClips: clips.length })
}
