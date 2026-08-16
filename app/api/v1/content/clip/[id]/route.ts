import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { clip4kEnabled } from "@/lib/platform/gating"
import { getClipSource, listClipsForSource } from "@/lib/content/store"

export const runtime = "nodejs"

// GET /api/v1/content/clip/[id] — detalhe da fonte + seus clipes (grade ranqueada).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  const { source, clips } = await withTenant(sql, a.tenantId, async (tx) => ({
    source: await getClipSource(tx, id),
    clips: await listClipsForSource(tx, id),
  }))
  if (!source) return json(404, { error: "fonte não encontrada" })
  // Grade ordenada por score (melhores momentos primeiro).
  clips.sort((x, y) => (y.score ?? 0) - (x.score ?? 0))
  const can4k = await clip4kEnabled(sql, a.tenantId)
  return json(200, { source, clips, can4k })
}
