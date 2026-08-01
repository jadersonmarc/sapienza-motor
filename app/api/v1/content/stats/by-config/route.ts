import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { byConfigForPeriod, currentPeriod } from "@/lib/metrics"

export const runtime = "nodejs"

// GET /api/v1/content/stats/by-config?period=AAAA-MM — desempenho agrupado por
// config_version (correlaciona geração × resultado). JWT do core.
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const url = new URL(req.url)
  const p = url.searchParams.get("period")
  const period = p && /^\d{4}-\d{2}$/.test(p) ? p : currentPeriod()
  const rows = await byConfigForPeriod(getDb(), a.tenantId, period)
  return json(200, { period, byConfig: rows })
}
