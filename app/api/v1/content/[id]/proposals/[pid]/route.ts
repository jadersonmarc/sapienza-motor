import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { acceptProposal, discardProposal } from "@/lib/content/store"

export const runtime = "nodejs"

// POST /api/v1/content/:id/proposals/:pid — aceita a proposta (vira a revisão atual).
export async function POST(req: Request, ctx: { params: Promise<{ id: string; pid: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id, pid } = await ctx.params
  const sql = getDb()
  const ok = await withTenant(sql, a.tenantId, (tx) => acceptProposal(tx, id, pid))
  if (!ok) return json(404, { error: "proposta não encontrada" })
  return json(200, { ok: true })
}

// DELETE /api/v1/content/:id/proposals/:pid — descarta a proposta.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; pid: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id, pid } = await ctx.params
  const sql = getDb()
  const ok = await withTenant(sql, a.tenantId, (tx) => discardProposal(tx, id, pid))
  if (!ok) return json(404, { error: "proposta não encontrada" })
  return json(200, { ok: true })
}
