import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate, clipperEnabled } from "@/lib/platform/gating"
import { clipHoursQuota } from "@/lib/content/quota"
import { createClipSource, listClipSources } from "@/lib/content/store"
import { pokeClipWorker } from "./poke"

export const runtime = "nodejs"

// GET /api/v1/content/clip — lista as fontes de vídeo do tenant (fila + status).
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const sql = getDb()
  const sources = await withTenant(sql, a.tenantId, (tx) => listClipSources(tx, 50))
  const quota = await clipHoursQuota(sql, a.tenantId)
  return json(200, { sources, quota })
}

// POST /api/v1/content/clip — cria uma fonte por URL (YouTube/Vimeo/…). O worker
// baixa, transcreve, analisa e gera os clipes em segundo plano. owner/admin.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })
  if (!(await clipperEnabled(sql, a.tenantId))) {
    return json(403, { error: "Clipes Inteligentes não disponível no seu plano" })
  }

  const body = (await req.json().catch(() => ({}))) as { url?: string }
  const url = (body.url ?? "").trim()
  if (!/^https?:\/\//i.test(url)) return json(400, { error: "informe uma URL de vídeo válida" })

  // Pré-gate de horas: se a cota já está esgotada, nem enfileira (o débito exato é no
  // probe, quando a duração é conhecida).
  const quota = await clipHoursQuota(sql, a.tenantId)
  if (quota.remainingMinutes <= 0) {
    return json(409, { error: "cota de horas de vídeo do plano esgotada neste mês; faça upgrade" })
  }

  const source = await withTenant(sql, a.tenantId, (tx) =>
    createClipSource(tx, { kind: "url", origin: url, authorId: a.userId }),
  )
  await pokeClipWorker()
  return json(202, { id: source.id, status: source.status })
}
