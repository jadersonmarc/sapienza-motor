import { authed, isResponse, json, runAfterResponse } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { getItem, addRevision, markGenerating, finishGenerating } from "@/lib/content/store"
import { assertRegenAllowed, RegenLimitError } from "@/lib/content/regenerate"
import { generateDraft, type ContentFormat } from "@/lib/ai/generate"
import { generatePieceImage } from "@/lib/content/piece-image"

export const runtime = "nodejs"

// POST /api/v1/content/:id/regenerate — nova revisão via IA (limite de 2/peça).
// O limite é checado SÍNCRONO (409); a geração roda em SEGUNDO PLANO (after()),
// imune a corte de proxy. Falha → content_items.generate_error (o console mostra).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  // Limite de regeneração: barra AQUI (síncrono) antes de agendar a IA.
  try {
    await assertRegenAllowed(sql, a.tenantId, id)
  } catch (e) {
    if (e instanceof RegenLimitError) return json(409, { error: e.message })
    throw e
  }

  const body = (await req.json().catch(() => ({}))) as { prompt?: string }
  const prompt = (body.prompt ?? "").trim()
  // Regenera no MESMO formato da peça (blog vs post social).
  const item = await withTenant(sql, a.tenantId, (tx) => getItem(tx, id))
  if (!item) return json(404, { error: "not found" })
  const format = (item.format ?? "blog") as ContentFormat

  await withTenant(sql, a.tenantId, (tx) => markGenerating(tx, id))

  await runAfterResponse(async () => {
    try {
      const draft = await generateDraft(prompt || "regenerar", format)
      await withTenant(sql, a.tenantId, (tx) =>
        addRevision(tx, id, {
          title: draft.title,
          bodyMarkdown: draft.bodyMarkdown,
          excerpt: draft.excerpt,
          ai: true, // regeneração conta no regen_count
          authorId: a.userId,
          seo: draft.keywords.length ? { keywords: draft.keywords } : undefined,
        }),
      )
      await withTenant(sql, a.tenantId, (tx) => finishGenerating(tx, id, null))
      // Nova descrição → renova a imagem on-brand (best-effort).
      await generatePieceImage(sql, a.tenantId, id).catch((e) =>
        console.error("[piece-image] falha ao regenerar:", e),
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[regenerate] falha em background (peça ${id}):`, msg)
      await withTenant(sql, a.tenantId, (tx) => finishGenerating(tx, id, msg)).catch(() => {})
    }
  })

  return json(202, { async: true })
}
