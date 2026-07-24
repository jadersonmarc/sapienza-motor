import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { getItem } from "@/lib/content/store"
import { regenerate, RegenLimitError } from "@/lib/content/regenerate"
import { generateDraft, type ContentFormat } from "@/lib/ai/generate"
import { generatePieceImage } from "@/lib/content/piece-image"

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
  // Regenera no MESMO formato da peça (blog vs post social).
  const item = await withTenant(sql, a.tenantId, (tx) => getItem(tx, id))
  const format = (item?.format ?? "blog") as ContentFormat
  try {
    const revisionId = await regenerate(sql, a.tenantId, id, async () => {
      const draft = await generateDraft(prompt || "regenerar", format)
      return { title: draft.title, bodyMarkdown: draft.bodyMarkdown, excerpt: draft.excerpt }
    })
    // Nova descrição → renova a imagem on-brand (best-effort).
    await generatePieceImage(sql, a.tenantId, id).catch((e) =>
      console.error("[piece-image] falha ao regenerar:", e),
    )
    return json(200, { revisionId })
  } catch (e) {
    if (e instanceof RegenLimitError) return json(409, { error: e.message })
    throw e
  }
}
