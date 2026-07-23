import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { listProposedRevisions } from "@/lib/content/store"

export const runtime = "nodejs"

// GET /api/v1/content/:id/proposals — revisões propostas pendentes da peça.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  const proposals = await withTenant(sql, a.tenantId, (tx) => listProposedRevisions(tx, id))
  return json(200, { proposals })
}
