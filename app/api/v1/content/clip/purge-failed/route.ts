import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { listFailedClipSources, listClipsForSource, deleteItem, deleteClipSource } from "@/lib/content/store"
import { safeDeleteObject } from "@/lib/storage/s3"
import { clipVideoKey } from "@/lib/storage/keys"

export const runtime = "nodejs"

// POST /api/v1/content/clip/purge-failed — limpeza em LOTE das fontes que falharam
// (status='error'), numa ação só. Só toca estado terminal, então nunca colide com job
// em andamento. Para cada fonte: clipes parciais (registro + MP4 no R2), o bruto no R2
// e a fonte (transcrição por cascade). SEM estorno de cota — o pipeline já estornou na
// falha (estornar de novo = duplo). Devolve contagens + bytes liberados. owner/admin.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const sql = getDb()

  const failed = await withTenant(sql, a.tenantId, (tx) => listFailedClipSources(tx))
  let deletedSources = 0
  let deletedClips = 0
  let freedBytes = 0

  for (const source of failed) {
    const clips = await withTenant(sql, a.tenantId, (tx) => listClipsForSource(tx, source.id))
    for (const c of clips) {
      await withTenant(sql, a.tenantId, (tx) => deleteItem(tx, c.id))
      freedBytes += await safeDeleteObject(a.tenantId, clipVideoKey({ slug: c.slug }), `purge clip=${c.id}`)
      deletedClips++
    }
    if (source.r2_key_raw) freedBytes += await safeDeleteObject(a.tenantId, source.r2_key_raw, `purge source=${source.id}`)
    await withTenant(sql, a.tenantId, (tx) => deleteClipSource(tx, source.id))
    deletedSources++
  }

  return json(200, { ok: true, deletedSources, deletedClips, freedBytes })
}
