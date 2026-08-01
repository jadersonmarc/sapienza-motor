import { json } from "@/lib/api/http"
import { cronAuthorized } from "@/lib/platform/webhook"
import { getDb } from "@/lib/db"
import { activeTenants } from "@/lib/platform/gating"
import { collectMetrics } from "@/lib/metrics"

export const runtime = "nodejs"

// POST /api/cron/collect-metrics — coleta o snapshot diário de métricas dos posts
// publicados (por canal com adapter + credencial). Varre todos os tenants Motor
// ativos. Idempotente por dia (São Paulo). Sem creds/adapter = no-op. 1×/dia.
// Protegido por x-webhook-secret.
export async function POST(req: Request): Promise<Response> {
  if (!cronAuthorized(req)) return json(401, { error: "unauthorized" })
  const sql = getDb()
  const tenants = await activeTenants(sql)

  let written = 0
  const errors: { tenantId: string; itemId: string; platform: string; error: string }[] = []
  for (const tenantId of tenants) {
    try {
      const r = await collectMetrics(sql, tenantId)
      written += r.written
      for (const f of r.failures) errors.push({ tenantId, ...f })
    } catch (e) {
      errors.push({ tenantId, itemId: "", platform: "", error: String(e instanceof Error ? e.message : e) })
    }
  }
  return json(200, { written, errors })
}
