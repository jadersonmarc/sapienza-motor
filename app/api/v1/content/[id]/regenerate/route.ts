import { authed, isResponse, json, runAfterResponse } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { getItem, addRevision, markGenerating, finishGenerating, setMotionMeta, setRenderStatus } from "@/lib/content/store"
import { getEditorConfig } from "@/lib/content/editor-config"
import { assertRegenAllowed, RegenLimitError } from "@/lib/content/regenerate"
import { generateDraft, type ContentFormat } from "@/lib/ai/generate"
import { generateMotion } from "@/lib/ai/motion"
import { isAiConfigured } from "@/lib/ai/client"
import { generatePieceImage } from "@/lib/content/piece-image"

export const runtime = "nodejs"

/** Combina o BRIEF ORIGINAL com o feedback de correção. O feedback é INSTRUÇÃO por
 *  cima do brief — NUNCA o substitui. Fallback de peça antiga (brief null, criada
 *  antes de persistirmos o brief): usa só o feedback, SEM inventar um brief falso. */
function combineBriefFeedback(brief: string | null, feedback: string): string {
  const fb = feedback.trim()
  if (brief && brief.trim()) {
    return fb ? `${brief.trim()}\n\nAjuste solicitado (regeração): ${fb}` : brief.trim()
  }
  return fb || "regenerar"
}

// Cutuca o worker de render do MOTION (fire-and-forget) — regeração de motion
// re-renderiza o vídeo. Sem URL/secret, o cron do motion pega depois.
async function pokeMotionRender(): Promise<void> {
  const url = process.env.MOTION_RENDER_URL
  const secret = process.env.WEBHOOK_SECRET
  if (!url || !secret) return
  try {
    await fetch(`${url.replace(/\/$/, "")}/trigger`, {
      method: "POST",
      headers: { "x-webhook-secret": secret },
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    /* cron pega depois */
  }
}

// POST /api/v1/content/:id/regenerate — nova revisão via IA (limite de 2/peça).
// Roteia POR TIPO: texto → generateDraft(brief+feedback) + capa; motion →
// generateMotion(brief+feedback) + re-render do vídeo (SEM capa); clipe → não aqui.
// Feedback NUNCA substitui o brief; brief original vem persistido na peça.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const item = await withTenant(sql, a.tenantId, (tx) => getItem(tx, id))
  if (!item) return json(404, { error: "not found" })

  // Clipe: NÃO se regenera por aqui (é reprocessando o vídeo-fonte). Sem isto, cairia
  // no caminho de texto+capa (o bug). Comportamento definitivo do clipe: a propor.
  if (item.is_clip) {
    return json(400, { error: "Clipes são regerados reprocessando o vídeo-fonte, não por aqui." })
  }
  // Ambos os caminhos exigem IA — sem chave, não geramos rascunho bogus.
  if (!isAiConfigured()) return json(503, { error: "IA não configurada (ANTHROPIC_API_KEY)." })

  // Limite de regeração: barra AQUI (síncrono) antes de agendar a IA.
  try {
    await assertRegenAllowed(sql, a.tenantId, id)
  } catch (e) {
    if (e instanceof RegenLimitError) return json(409, { error: e.message })
    throw e
  }

  const body = (await req.json().catch(() => ({}))) as { prompt?: string }
  const feedback = (body.prompt ?? "").trim()
  const brief = combineBriefFeedback(item.brief, feedback)
  const isMotion = item.is_motion === true
  const format = (item.format ?? "blog") as ContentFormat

  await withTenant(sql, a.tenantId, (tx) => markGenerating(tx, id))

  await runAfterResponse(async () => {
    try {
      if (isMotion) {
        // MOTION: regenera os motion_props e RE-RENDERIZA o vídeo. NUNCA capa estática.
        const cfg = await withTenant(sql, a.tenantId, (tx) => getEditorConfig(tx))
        const content = await generateMotion(brief, {
          systemPrompt: cfg.system_prompt,
          tone: cfg.tone,
          themes: cfg.themes,
          model: cfg.model ?? undefined,
        })
        await withTenant(sql, a.tenantId, async (tx) => {
          await addRevision(tx, id, {
            title: content.title,
            bodyMarkdown: content.caption,
            excerpt: content.caption.slice(0, 140),
            ai: true,
            authorId: a.userId,
            motionProps: content.props as unknown as Record<string, unknown>,
          })
          await setMotionMeta(tx, id, { preset: content.preset, aspect: content.aspect })
          await finishGenerating(tx, id, null)
          await setRenderStatus(tx, id, "queued") // volta para a fila de render
        })
        await pokeMotionRender()
      } else {
        // TEXTO: novo rascunho com brief+feedback, mesmo formato; renova a capa on-brand.
        const draft = await generateDraft(brief, format)
        await withTenant(sql, a.tenantId, (tx) =>
          addRevision(tx, id, {
            title: draft.title,
            bodyMarkdown: draft.bodyMarkdown,
            excerpt: draft.excerpt,
            ai: true,
            authorId: a.userId,
            seo: draft.keywords.length ? { keywords: draft.keywords } : undefined,
          }),
        )
        await withTenant(sql, a.tenantId, (tx) => finishGenerating(tx, id, null))
        await generatePieceImage(sql, a.tenantId, id).catch((e) =>
          console.error("[piece-image] falha ao regenerar:", e),
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[regenerate] falha em background (peça ${id}):`, msg)
      await withTenant(sql, a.tenantId, (tx) => finishGenerating(tx, id, msg)).catch(() => {})
    }
  })

  return json(202, { async: true })
}
