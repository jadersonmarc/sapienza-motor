import { authed, isResponse, json, runAfterResponse } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate, motionEnabled } from "@/lib/platform/gating"
import { createMotionItem, addRevision, setMotionMeta, finishGenerating, setRenderStatus } from "@/lib/content/store"
import { getEditorConfig } from "@/lib/content/editor-config"
import { generateMotion } from "@/lib/ai/motion"
import { slugify } from "@/lib/content/slug"
import { reserveGeneration, refundGeneration, GenerationQuotaError } from "@/lib/content/quota"

export const runtime = "nodejs"

// POST /api/v1/content/motion — cria uma peça de MOTION (vídeo animado). CAPABILITY:
// só tenants com motion habilitado no plano (Pro/Premium) — senão 403. A peça nasce
// generating + render_status='queued'; o conteúdo do preset é gerado do brief em
// segundo plano (after()); o serviço de render pega a fila, renderiza e leva p/ aprovação.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  // Capability derivada do plano — nada hardcoded (lê product_rules.motion_enabled).
  if (!(await motionEnabled(sql, a.tenantId))) {
    return json(403, { error: "motion não disponível no seu plano (disponível no Pro e no Premium)" })
  }

  const body = (await req.json().catch(() => ({}))) as { prompt?: string; channel?: string }
  const prompt = (body.prompt ?? "").trim()
  // Canal-alvo do vídeo (define o formato da peça). Fase 1 publica só pelo Webhook;
  // na Fase 2 o publish nativo usa este canal (instagram/linkedin).
  const channel = body.channel === "linkedin" ? "linkedin" : "instagram"

  // Cota de peça (motion consome como qualquer peça) — debita antes de agendar a IA.
  try {
    await reserveGeneration(sql, a.tenantId)
  } catch (e) {
    if (e instanceof GenerationQuotaError) return json(409, { error: e.message })
    throw e
  }

  const cfg = await withTenant(sql, a.tenantId, (tx) => getEditorConfig(tx))
  const slug = `${slugify(prompt) || "motion"}-${Date.now().toString(36)}`
  const item = await withTenant(sql, a.tenantId, (tx) =>
    createMotionItem(tx, { slug, format: channel, authorId: a.userId }),
  )

  await runAfterResponse(async () => {
    try {
      const content = await generateMotion(prompt, {
        systemPrompt: cfg.system_prompt,
        tone: cfg.tone,
        themes: cfg.themes,
        model: cfg.model ?? undefined,
      })
      await withTenant(sql, a.tenantId, async (tx) => {
        await addRevision(tx, item.id, {
          title: content.title,
          bodyMarkdown: content.caption, // legenda p/ publicação (webhook)
          excerpt: content.caption.slice(0, 140),
          ai: false,
          authorId: a.userId,
          motionProps: content.props as unknown as Record<string, unknown>,
        })
        await setMotionMeta(tx, item.id, { preset: content.preset, aspect: content.aspect })
        await finishGenerating(tx, item.id, null)
      })
      // render_status segue 'queued' → o serviço de render pega a fila.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[motion] falha ao gerar conteúdo (peça ${item.id}):`, msg)
      await refundGeneration(sql, a.tenantId).catch(() => {})
      await withTenant(sql, a.tenantId, async (tx) => {
        await finishGenerating(tx, item.id, msg)
        await setRenderStatus(tx, item.id, "error", msg) // tira da fila do render
      }).catch(() => {})
    }
  })

  return json(202, { id: item.id, slug, async: true })
}
