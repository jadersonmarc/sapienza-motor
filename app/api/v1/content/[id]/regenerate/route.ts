import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { canOperate } from "@/lib/platform/gating"
import { regenerate, RegenLimitError } from "@/lib/content/regenerate"
import { generateDraft } from "@/lib/ai/generate"

export const runtime = "nodejs"

// POST /api/v1/content/:id/regenerate — nova revisão via IA (limite de 2/peça).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { prompt?: string }
  const prompt = (body.prompt ?? "").trim()
  try {
    const revisionId = await regenerate(sql, a.tenantId, id, async () => {
      const draft = await generateDraft(prompt || "regenerar")
      return { title: draft.title, bodyMarkdown: draft.bodyMarkdown, excerpt: draft.excerpt }
    })
    return json(200, { revisionId })
  } catch (e) {
    if (e instanceof RegenLimitError) return json(409, { error: e.message })
    throw e
  }
}
