import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { getItem, addRevision } from "@/lib/content/store"

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

// PUT /api/v1/content/:id — edição manual: cria uma nova revisão (não-IA) com o
// título/corpo editados e a torna a revisão atual da peça.
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const body = (await req.json().catch(() => null)) as
    | { title?: string; bodyMarkdown?: string; excerpt?: string }
    | null
  const title = body?.title?.trim()
  const bodyMarkdown = body?.bodyMarkdown?.trim()
  if (!title || !bodyMarkdown) {
    return json(400, { error: "title e bodyMarkdown são obrigatórios" })
  }
  const sql = getDb()
  const revId = await withTenant(sql, a.tenantId, async (tx) => {
    const it = await getItem(tx, id)
    if (!it) return null
    return addRevision(tx, id, {
      title,
      bodyMarkdown,
      excerpt: body?.excerpt?.trim() || undefined,
      ai: false,
      authorId: a.userId,
    })
  })
  if (!revId) return json(404, { error: "not found" })
  return json(200, { revision_id: revId })
}
