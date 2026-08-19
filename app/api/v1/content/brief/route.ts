import { authed, isResponse, json, runAfterResponse } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { createGeneratingItem, addRevision, finishGenerating } from "@/lib/content/store"
import { generatePieceImage } from "@/lib/content/piece-image"
import { assertReadyToCreate, NotReadyError } from "@/lib/content/readiness"
import { generateFromBrief } from "@/lib/ai/brief"
import { slugify } from "@/lib/content/slug"
import { reserveGeneration, refundGeneration, GenerationQuotaError } from "@/lib/content/quota"

export const runtime = "nodejs"

// POST /api/v1/content/brief — cria uma peça a partir de um brief estruturado
// (objetivo, pontos-chave, público, tom, pilar). Produtor separado do cron.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as {
    objetivo?: string
    pontosChave?: string
    publico?: string
    tom?: string
    pilar?: string
  }
  const objetivo = (body.objetivo ?? "").trim()
  if (!objetivo) return json(400, { error: "objetivo obrigatório" })

  // Pronto para criar? (identidade do agente + canal conectado).
  const ready = await assertReadyToCreate(sql, a.tenantId).catch((e) => {
    if (e instanceof NotReadyError) return json(409, { error: e.message })
    throw e
  })
  if (ready instanceof Response) return ready
  const { cfg } = ready

  // Debita a cota antes de agendar o modelo — é a chamada que custa (refund na falha).
  try {
    await reserveGeneration(sql, a.tenantId)
  } catch (e) {
    if (e instanceof GenerationQuotaError) return json(409, { error: e.message })
    throw e
  }

  // Cria já (generating) e gera o rascunho em segundo plano (after()) — igual ao
  // POST /content: imune a corte de proxy; falha vai p/ generate_error + refund.
  const pilar = body.pilar ?? null
  // Brief ORIGINAL persistido (texto do brief estruturado) — a regeração o combina
  // com o feedback depois.
  const brief = [
    `Objetivo: ${objetivo}`,
    body.pontosChave?.trim() ? `Pontos-chave: ${body.pontosChave.trim()}` : "",
    body.publico?.trim() ? `Público: ${body.publico.trim()}` : "",
    body.tom?.trim() ? `Tom: ${body.tom.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n")
  const slug = `${slugify(objetivo) || "rascunho"}-${Date.now().toString(36)}`
  const item = await withTenant(sql, a.tenantId, (tx) =>
    createGeneratingItem(tx, { slug, pilar, authorId: a.userId, brief }),
  )

  await runAfterResponse(async () => {
    try {
      const draft = await generateFromBrief({
        objetivo,
        pontosChave: body.pontosChave,
        publico: body.publico,
        tom: body.tom || cfg.tone,
        pilar,
        systemPrompt: cfg.system_prompt,
      })
      await withTenant(sql, a.tenantId, (tx) =>
        addRevision(tx, item.id, {
          title: draft.title,
          bodyMarkdown: draft.bodyMarkdown,
          excerpt: draft.excerpt,
          ai: false,
          authorId: a.userId,
          seo: draft.keywords.length ? { keywords: draft.keywords } : undefined,
        }),
      )
      await withTenant(sql, a.tenantId, (tx) => finishGenerating(tx, item.id, null))
      await generatePieceImage(sql, a.tenantId, item.id).catch((e) =>
        console.error("[piece-image] falha ao gerar no brief:", e),
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[generate-brief] falha em background (peça ${item.id}):`, msg)
      await refundGeneration(sql, a.tenantId).catch(() => {})
      await withTenant(sql, a.tenantId, (tx) => finishGenerating(tx, item.id, msg)).catch(() => {})
    }
  })

  return json(202, { id: item.id, slug, async: true })
}
