import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { getItem } from "@/lib/content/store"

export const runtime = "nodejs"

// GET /api/v1/content/:id — uma peça (+ revisão atual).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  const item = await withTenant(sql, a.tenantId, async (tx) => {
    const it = await getItem(tx, id)
    if (!it) return null
    const rev = (await tx`
      SELECT title, body_markdown, excerpt FROM content_revisions WHERE id = ${it.current_revision_id}
    `) as unknown as { title: string; body_markdown: string; excerpt: string | null }[]
    return { ...it, revision: rev[0] ?? null }
  })
  if (!item) return json(404, { error: "not found" })
  return json(200, item)
}
