import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { getItemWithRevision, insertAnalysis, listAnalyses } from "@/lib/content/store"
import { runAnalyzer, isAnalysisType, AiNotConfiguredError, ANALYZER_LIST } from "@/lib/ai/analyzers"

export const runtime = "nodejs"

// GET /api/v1/content/:id/analyze — lista as análises salvas + os tipos disponíveis.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  const analyses = await withTenant(sql, a.tenantId, (tx) => listAnalyses(tx, id))
  return json(200, { analyses, types: ANALYZER_LIST })
}

// POST /api/v1/content/:id/analyze — { type } roda um analisador (exige IA) e salva
// o resultado em ai_analyses. Sem ANTHROPIC_API_KEY → 503.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { type?: string }
  const type = body.type ?? ""
  if (!isAnalysisType(type)) return json(400, { error: "type inválido (quality|seo|emotional|thematic)" })

  const rev = await withTenant(sql, a.tenantId, (tx) => getItemWithRevision(tx, id))
  if (!rev) return json(404, { error: "not found" })

  try {
    const { payload, model } = await runAnalyzer(type, {
      title: rev.title,
      bodyMarkdown: rev.body_markdown,
      excerpt: rev.excerpt ?? "",
      pilar: rev.pilar,
      keywords: Array.isArray((rev.seo as { keywords?: string[] })?.keywords)
        ? (rev.seo as { keywords: string[] }).keywords
        : undefined,
    })
    await withTenant(sql, a.tenantId, (tx) =>
      insertAnalysis(tx, { itemId: id, revisionId: rev.id, type, payload, model }),
    )
    return json(200, { type, payload, model })
  } catch (e) {
    if (e instanceof AiNotConfiguredError) return json(503, { error: "IA não configurada" })
    throw e
  }
}
