import { json } from "@/lib/api/http"
import { cronAuthorized } from "@/lib/platform/webhook"
import { getDb } from "@/lib/db"
import { activeTenants } from "@/lib/platform/gating"
import { withTenant } from "@/lib/platform/tenancy"
import { createItem, listItemTitles } from "@/lib/content/store"
import { generateDraft, isAiConfigured } from "@/lib/ai/generate"
import { slugify } from "@/lib/content/slug"
import { reserveGeneration, refundGeneration, GenerationQuotaError } from "@/lib/content/quota"

export const runtime = "nodejs"

// POST /api/cron/generate-draft — para cada tenant Motor ativo, gera UMA peça nova
// em draft (renovação de tema: evita repetir os títulos já existentes). Exige IA
// (draft de máquina só faz sentido com o modelo). Protegido por x-webhook-secret.
// Body opcional: { prompt?, pilar?, themeSeeds? }.
export async function POST(req: Request): Promise<Response> {
  if (!cronAuthorized(req)) return json(401, { error: "unauthorized" })
  if (!isAiConfigured()) return json(503, { error: "ANTHROPIC_API_KEY não configurada" })

  const body = (await req.json().catch(() => ({}))) as {
    prompt?: string
    pilar?: string
    themeSeeds?: string[]
  }
  const prompt = (body.prompt ?? "").trim()
  const pilar = body.pilar ?? null

  const sql = getDb()
  const tenants = await activeTenants(sql)
  const created: { tenantId: string; itemId: string; slug: string }[] = []
  const skipped: { tenantId: string; reason: string }[] = []
  const errors: { tenantId: string; error: string }[] = []

  for (const tenantId of tenants) {
    try {
      // O cron consome a mesma cota do tenant. Sem cota não é erro: o tenant já
      // usou o que o plano dá no mês, então simplesmente não geramos para ele.
      try {
        await reserveGeneration(sql, tenantId)
      } catch (e) {
        if (e instanceof GenerationQuotaError) {
          skipped.push({ tenantId, reason: e.message })
          continue
        }
        throw e
      }

      const avoidTitles = await withTenant(sql, tenantId, (tx) => listItemTitles(tx))
      let draft
      try {
        draft = await generateDraft(prompt, { avoidTitles, themeSeeds: body.themeSeeds })
      } catch (e) {
        await refundGeneration(sql, tenantId)
        throw e
      }
      const slug = `${draft.slug || slugify(prompt) || "rascunho"}-${Date.now().toString(36)}`
      const item = await withTenant(sql, tenantId, (tx) =>
        createItem(tx, {
          slug,
          title: draft.title,
          bodyMarkdown: draft.bodyMarkdown,
          excerpt: draft.excerpt,
          pilar,
          seo: draft.keywords.length ? { keywords: draft.keywords } : undefined,
        }),
      )
      created.push({ tenantId, itemId: item.id, slug })
    } catch (e) {
      errors.push({ tenantId, error: String(e instanceof Error ? e.message : e) })
    }
  }
  return json(200, { created, skipped, errors })
}
