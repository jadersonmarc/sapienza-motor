import { json } from "@/lib/api/http"
import { cronAuthorized } from "@/lib/platform/webhook"
import { getDb } from "@/lib/db"
import { activeTenants } from "@/lib/platform/gating"
import { withTenant } from "@/lib/platform/tenancy"
import {
  listExpiredClipRaw,
  clearClipRaw,
  listExpiredClipSourceIds,
  listClipsForSource,
  deleteClipSource,
  deleteItem,
  getClipSource,
  listClipSourcesToWarn,
  markClipSourceWarned,
} from "@/lib/content/store"
import { emitClipsExpiring } from "@/lib/platform/events"
import { safeDeleteObject, isStorageConfigured } from "@/lib/storage/s3"
import { clipVideoKey } from "@/lib/storage/keys"

export const runtime = "nodejs"

const WARN_DAYS = 3

// POST /api/cron/clip-retention — ciclo de expiração dos ativos do Clipper (§3.8):
// bruto em 7d, transcrição/JSON e clipes renderizados em 60d, com aviso 3 dias antes.
// Protegido por x-webhook-secret. Idempotente (roda diário).
export async function POST(req: Request): Promise<Response> {
  if (!cronAuthorized(req)) return json(401, { error: "unauthorized" })
  const sql = getDb()
  const tenants = await activeTenants(sql)
  const store = isStorageConfigured()

  let rawDeleted = 0
  let clipsDeleted = 0
  let sourcesDeleted = 0
  let warned = 0

  for (const tenantId of tenants) {
    // 1) Vídeo-fonte bruto vencido (7d): remove do R2 e limpa a referência.
    const raws = await withTenant(sql, tenantId, (tx) => listExpiredClipRaw(tx))
    for (const r of raws) {
      if (store) await safeDeleteObject(tenantId, r.r2_key_raw, `retention-raw source=${r.id}`)
      await withTenant(sql, tenantId, (tx) => clearClipRaw(tx, r.id))
      rawDeleted++
    }

    // 2) Aviso 3 dias antes da remoção dos clipes (uma vez por fonte).
    const toWarn = await withTenant(sql, tenantId, (tx) => listClipSourcesToWarn(tx, WARN_DAYS))
    for (const s of toWarn) {
      await withTenant(sql, tenantId, async (tx) => {
        const src = await getClipSource(tx, s.id)
        if (src && src.expires_at) {
          await emitClipsExpiring(tx, { tenantId, sourceId: src.id, clips: src.clips_count, expiresAt: src.expires_at })
        }
        await markClipSourceWarned(tx, s.id)
      })
      warned++
    }

    // 3) Fonte totalmente vencida (60d): remove clipes (content_item + MP4) e a fonte
    //    (transcrição cai por cascade).
    const expired = await withTenant(sql, tenantId, (tx) => listExpiredClipSourceIds(tx))
    for (const sourceId of expired) {
      const clips = await withTenant(sql, tenantId, (tx) => listClipsForSource(tx, sourceId))
      for (const c of clips) {
        if (store) await safeDeleteObject(tenantId, clipVideoKey({ slug: c.slug }), `retention-clip clip=${c.id}`)
        await withTenant(sql, tenantId, (tx) => deleteItem(tx, c.id))
        clipsDeleted++
      }
      await withTenant(sql, tenantId, (tx) => deleteClipSource(tx, sourceId))
      sourcesDeleted++
    }
  }

  return json(200, { rawDeleted, clipsDeleted, sourcesDeleted, warned })
}
