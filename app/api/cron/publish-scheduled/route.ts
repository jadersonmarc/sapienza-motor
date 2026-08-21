import { json } from "@/lib/api/http"
import { cronAuthorized } from "@/lib/platform/webhook"
import { getDb } from "@/lib/db"
import { activeTenants } from "@/lib/platform/gating"
import { withTenant } from "@/lib/platform/tenancy"
import { listDueScheduled } from "@/lib/content/store"
import { publishItem } from "@/lib/channels/registry"
import { emitCronRun } from "@/lib/platform/events"
import { isConnError } from "@/lib/platform/net-error"

export const runtime = "nodejs"

// POST /api/cron/publish-scheduled — publica peças 'scheduled' com scheduled_at vencido.
// Varre todos os tenants Motor ativos. Protegido por x-webhook-secret.
export async function POST(req: Request): Promise<Response> {
  if (!cronAuthorized(req)) return json(401, { error: "unauthorized" })
  const sql = getDb()
  const tenants = await activeTenants(sql)

  let published = 0
  let appErrors = 0
  let connErrors = 0
  const errors: { tenantId: string; itemId: string; error: string }[] = []
  for (const tenantId of tenants) {
    const due = await withTenant(sql, tenantId, (tx) => listDueScheduled(tx))
    for (const item of due) {
      try {
        await publishItem(sql, tenantId, item.id)
        published++
      } catch (e) {
        // Peça continua 'scheduled' (publishItem só avança no sucesso) → reprocessada
        // na próxima execução, sem perda e sem repost (idempotência por canal).
        if (isConnError(e)) connErrors++
        else appErrors++
        errors.push({ tenantId, itemId: item.id, error: String(e instanceof Error ? e.message : e) })
      }
    }
  }
  await emitCronRun(sql, { job: "publish-scheduled", processed: published, appErrors, connErrors }).catch((e) =>
    console.error("[cron] emitCronRun falhou:", e),
  )
  return json(200, { published, errors })
}
