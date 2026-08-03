import { json } from "@/lib/api/http"
import { cronAuthorized } from "@/lib/platform/webhook"
import { getDb } from "@/lib/db"
import { activeTenants } from "@/lib/platform/gating"
import { refreshExpiringChannels } from "@/lib/channels/registry"

export const runtime = "nodejs"

// POST /api/cron/refresh-tokens — renova os tokens OAuth dos canais perto de expirar
// (o cliente conecta uma vez; a Sapienza mantém o token vivo). Varre os tenants
// Motor ativos; best-effort por canal. Seam: sem app OAuth configurado, é no-op.
// 1×/dia. Protegido por x-webhook-secret.
export async function POST(req: Request): Promise<Response> {
  if (!cronAuthorized(req)) return json(401, { error: "unauthorized" })
  const sql = getDb()
  const tenants = await activeTenants(sql)
  const errors: { tenantId: string; error: string }[] = []
  for (const tenantId of tenants) {
    try {
      await refreshExpiringChannels(sql, tenantId)
    } catch (e) {
      errors.push({ tenantId, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return json(200, { tenants: tenants.length, errors })
}
