import { json } from "@/lib/api/http"
import { cronAuthorized } from "@/lib/platform/webhook"
import { emitCronRun } from "@/lib/platform/events"
import { splitCronErrors } from "@/lib/platform/net-error"
import { getDb } from "@/lib/db"
import { activeTenants } from "@/lib/platform/gating"
import { collectMetrics, collectChannelMetrics } from "@/lib/metrics"

export const runtime = "nodejs"

// POST /api/cron/collect-metrics — coleta o snapshot diário de métricas: por POST
// (post_metrics) e de CONTA (channel_metrics, seguidores/alcance). Varre todos os
// tenants Motor ativos. Idempotente por dia (São Paulo). Sem creds/adapter = no-op.
// 1×/dia. Protegido por x-webhook-secret.
export async function POST(req: Request): Promise<Response> {
  if (!cronAuthorized(req)) return json(401, { error: "unauthorized" })
  const sql = getDb()
  const tenants = await activeTenants(sql)

  let written = 0
  let accounts = 0
  const errors: { tenantId: string; itemId?: string; platform: string; error: string }[] = []
  for (const tenantId of tenants) {
    try {
      const r = await collectMetrics(sql, tenantId)
      written += r.written
      for (const f of r.failures) errors.push({ tenantId, ...f })
      const c = await collectChannelMetrics(sql, tenantId)
      accounts += c.written
      for (const f of c.failures) errors.push({ tenantId, ...f })
    } catch (e) {
      errors.push({ tenantId, platform: "", error: String(e instanceof Error ? e.message : e) })
    }
  }
  const { appErrors, connErrors } = splitCronErrors(errors)
  await emitCronRun(sql, { job: "collect-metrics", processed: written, appErrors, connErrors }).catch((e) =>
    console.error("[cron] emitCronRun falhou:", e),
  )
  return json(200, { written, accounts, errors })
}
