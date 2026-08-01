import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { statsForPeriod, currentPeriod } from "@/lib/metrics"

export const runtime = "nodejs"

// GET /api/v1/content/stats?period=AAAA-MM — desempenho dos posts como série
// temporal diária + totais + quebra por pilar (envelope compartilhado com a
// Atendente). Default = período corrente (mês São Paulo). JWT do core.
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const url = new URL(req.url)
  const q = url.searchParams.get("period")
  const period = q && /^\d{4}-\d{2}$/.test(q) ? q : currentPeriod()
  const stats = await statsForPeriod(getDb(), a.tenantId, period)
  return json(200, stats)
}
