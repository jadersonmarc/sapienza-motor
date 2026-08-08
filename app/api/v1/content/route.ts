import { authed, isResponse, json, runAfterResponse } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { createGeneratingItem, addRevision, finishGenerating, listItems } from "@/lib/content/store"
import { generatePieceImage } from "@/lib/content/piece-image"
import { assertReadyToCreate, NotReadyError } from "@/lib/content/readiness"
import { generateDraft, type ContentFormat } from "@/lib/ai/generate"

const FORMATS: ContentFormat[] = ["blog", "linkedin", "instagram"]
import { slugify } from "@/lib/content/slug"
import { reserveGeneration, refundGeneration, GenerationQuotaError } from "@/lib/content/quota"

export const runtime = "nodejs"

// GET /api/v1/content — lista as peças do tenant.
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const sql = getDb()
  const items = await withTenant(sql, a.tenantId, (tx) => listItems(tx))
  return json(200, { items })
}

// POST /api/v1/content — cria uma peça a partir de um tema. A peça é criada JÁ
// (generating=true) e retorna na hora (202); o rascunho é escrito em SEGUNDO PLANO
// (after()), imune a corte de proxy (ex.: limite de ~100s do Cloudflare). Falha no
// background fica em content_items.generate_error (o console mostra) e devolve a cota.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { prompt?: string; format?: string }
  const prompt = (body.prompt ?? "").trim()
  if (!prompt) return json(400, { error: "prompt required" })
  const format: ContentFormat = FORMATS.includes(body.format as ContentFormat)
    ? (body.format as ContentFormat)
    : "blog"

  // Pronto para criar? (identidade do agente + canal conectado). Voz/tom vêm daqui.
  const ready = await assertReadyToCreate(sql, a.tenantId).catch((e) => {
    if (e instanceof NotReadyError) return json(409, { error: e.message })
    throw e
  })
  if (ready instanceof Response) return ready
  const { cfg, formats } = ready
  // O formato escolhido precisa ter um canal conectado (senão a peça nasce sem destino).
  if (!formats.includes(format)) {
    return json(409, { error: `Conecte um canal de ${format} antes de criar peças nesse formato (conectados: ${formats.join(", ")}).` })
  }

  // Debita a cota antes de agendar o modelo — é a chamada que custa (refund na falha).
  try {
    await reserveGeneration(sql, a.tenantId)
  } catch (e) {
    if (e instanceof GenerationQuotaError) return json(409, { error: e.message })
    throw e
  }

  const slug = `${slugify(prompt) || "rascunho"}-${Date.now().toString(36)}`
  const item = await withTenant(sql, a.tenantId, (tx) =>
    createGeneratingItem(tx, { slug, format, authorId: a.userId }),
  )

  await runAfterResponse(async () => {
    try {
      const draft = await generateDraft(prompt, format, {
        systemPrompt: cfg.system_prompt,
        tone: cfg.tone,
        model: cfg.model ?? undefined,
      })
      await withTenant(sql, a.tenantId, (tx) =>
        addRevision(tx, item.id, {
          title: draft.title,
          bodyMarkdown: draft.bodyMarkdown,
          excerpt: draft.excerpt,
          ai: false, // 1º rascunho não conta como regeneração
          authorId: a.userId,
          seo: draft.keywords.length ? { keywords: draft.keywords } : undefined,
        }),
      )
      await withTenant(sql, a.tenantId, (tx) => finishGenerating(tx, item.id, null))
      // A imagem on-brand nasce junto com a descrição (best-effort — sem storage, pula).
      await generatePieceImage(sql, a.tenantId, item.id).catch((e) =>
        console.error("[piece-image] falha ao gerar na criação:", e),
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[generate] falha em background (peça ${item.id}):`, msg)
      await refundGeneration(sql, a.tenantId).catch(() => {}) // não gerou: devolve a cota
      await withTenant(sql, a.tenantId, (tx) => finishGenerating(tx, item.id, msg)).catch(() => {})
    }
  })

  return json(202, { id: item.id, slug, async: true })
}
