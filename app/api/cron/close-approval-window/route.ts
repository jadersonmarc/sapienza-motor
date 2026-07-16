import { json } from "@/lib/api/http"
import { cronAuthorized } from "@/lib/platform/webhook"
import { getDb } from "@/lib/db"
import { activeTenants } from "@/lib/platform/gating"
import { withTenant } from "@/lib/platform/tenancy"
import { listExpiredReview } from "@/lib/content/store"
import { publishItem } from "@/lib/channels/registry"

export const runtime = "nodejs"

// POST /api/cron/close-approval-window — janela de aprovação de 48h: peças 'in_review'
// com review_deadline_at vencido são publicadas (silêncio = aprovado). Protegido por secret.
export async function POST(req: Request): Promise<Response> {
  if (!cronAuthorized(req)) return json(401, { error: "unauthorized" })
  const sql = getDb()
  const tenants = await activeTenants(sql)

  let published = 0
  const errors: { tenantId: string; itemId: string; error: string }[] = []
  for (const tenantId of tenants) {
    const expired = await withTenant(sql, tenantId, (tx) => listExpiredReview(tx))
    for (const item of expired) {
      try {
        await publishItem(sql, tenantId, item.id)
        published++
      } catch (e) {
        errors.push({ tenantId, itemId: item.id, error: String(e instanceof Error ? e.message : e) })
      }
    }
  }
  return json(200, { published, errors })
}
