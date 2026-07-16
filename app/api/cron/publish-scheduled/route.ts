import { json } from "@/lib/api/http"
import { cronAuthorized } from "@/lib/platform/webhook"
import { getDb } from "@/lib/db"
import { activeTenants } from "@/lib/platform/gating"
import { withTenant } from "@/lib/platform/tenancy"
import { listDueScheduled } from "@/lib/content/store"
import { publishItem } from "@/lib/channels/registry"

export const runtime = "nodejs"

// POST /api/cron/publish-scheduled — publica peças 'scheduled' com scheduled_at vencido.
// Varre todos os tenants Motor ativos. Protegido por x-webhook-secret.
export async function POST(req: Request): Promise<Response> {
  if (!cronAuthorized(req)) return json(401, { error: "unauthorized" })
  const sql = getDb()
  const tenants = await activeTenants(sql)

  let published = 0
  const errors: { tenantId: string; itemId: string; error: string }[] = []
  for (const tenantId of tenants) {
    const due = await withTenant(sql, tenantId, (tx) => listDueScheduled(tx))
    for (const item of due) {
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
