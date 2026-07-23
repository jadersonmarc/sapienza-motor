import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { getItemWithRevision, insertProposedRevision } from "@/lib/content/store"
import { reviseWithRecommendation } from "@/lib/ai/revise"
import { isAiConfigured } from "@/lib/ai/client"

export const runtime = "nodejs"

// POST /api/v1/content/:id/apply-recommendation — gera uma revisão PROPOSTA que
// implementa a recomendação (de uma análise), sem virar a revisão atual.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  if (!isAiConfigured()) return json(503, { error: "ANTHROPIC_API_KEY não configurada" })
  const { id } = await ctx.params
  const body = (await req.json().catch(() => null)) as { type?: string; recommendation?: string } | null
  const recommendation = body?.recommendation?.trim()
  if (!recommendation) return json(400, { error: "recommendation é obrigatória" })

  const sql = getDb()
  const current = await withTenant(sql, a.tenantId, (tx) => getItemWithRevision(tx, id))
  if (!current) return json(404, { error: "not found" })

  let revised: { title: string; excerpt: string; bodyMarkdown: string }
  try {
    revised = await reviseWithRecommendation(
      { title: current.title, bodyMarkdown: current.body_markdown, excerpt: current.excerpt },
      recommendation,
      body?.type,
    )
  } catch (e) {
    return json(502, { error: e instanceof Error ? e.message : "falha na IA" })
  }

  const proposalId = await withTenant(sql, a.tenantId, (tx) =>
    insertProposedRevision(
      tx,
      id,
      { title: revised.title, bodyMarkdown: revised.bodyMarkdown, excerpt: revised.excerpt },
      { type: body?.type, recommendation },
    ),
  )
  return json(201, { proposal_id: proposalId })
}
