import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { topPostsForPeriod, currentPeriod } from "@/lib/metrics"

export const runtime = "nodejs"

// GET /api/v1/content/stats/top?period=AAAA-MM&limit=N — melhores posts do período
// por impressões (com título/pilar/formato). JWT do core.
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const url = new URL(req.url)
  const p = url.searchParams.get("period")
  const period = p && /^\d{4}-\d{2}$/.test(p) ? p : currentPeriod()
  const limit = Number(url.searchParams.get("limit") ?? 5)
  const top = await topPostsForPeriod(getDb(), a.tenantId, period, Number.isFinite(limit) ? limit : 5)
  return json(200, { period, top })
}
