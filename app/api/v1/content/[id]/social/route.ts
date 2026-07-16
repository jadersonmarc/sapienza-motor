import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { getItemWithRevision, upsertSocialDraft, listSocialDrafts } from "@/lib/content/store"
import { generateSocial, isSocialPlatform, SOCIAL_PLATFORMS } from "@/lib/ai/social"

export const runtime = "nodejs"

// GET /api/v1/content/:id/social — rascunhos sociais salvos + plataformas disponíveis.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  const drafts = await withTenant(sql, a.tenantId, (tx) => listSocialDrafts(tx, id))
  return json(200, { drafts, platforms: SOCIAL_PLATFORMS })
}

// PUT /api/v1/content/:id/social — salva uma legenda EDITADA à mão (body + hashtags)
// antes de publicar. Substitui o rascunho da plataforma (status draft). O publish a envia.
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as {
    platform?: string
    body?: string
    hashtags?: unknown
  }
  const platform = body.platform ?? ""
  if (!isSocialPlatform(platform)) return json(400, { error: "platform inválida (instagram|linkedin)" })
  const text = (body.body ?? "").trim()
  if (!text) return json(400, { error: "body obrigatório" })
  const hashtags = Array.isArray(body.hashtags)
    ? body.hashtags.map((h) => String(h).replace(/^#+/, "").trim()).filter(Boolean)
    : []

  await withTenant(sql, a.tenantId, (tx) =>
    upsertSocialDraft(tx, { itemId: id, platform, body: text, hashtags }),
  )
  return json(200, { platform, body: text, hashtags })
}

// POST /api/v1/content/:id/social — gera a legenda social (IG/LinkedIn) da revisão
// atual e salva como rascunho editável (social_drafts, status draft). Sem IA cai
// num fallback determinístico. O publish prefere esse rascunho ao markdown cru.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { platform?: string }
  const platform = body.platform ?? ""
  if (!isSocialPlatform(platform)) return json(400, { error: "platform inválida (instagram|linkedin)" })

  const rev = await withTenant(sql, a.tenantId, (tx) => getItemWithRevision(tx, id))
  if (!rev) return json(404, { error: "not found" })

  const result = await generateSocial(platform, {
    title: rev.title,
    bodyMarkdown: rev.body_markdown,
    excerpt: rev.excerpt ?? "",
    pilar: rev.pilar,
  })
  await withTenant(sql, a.tenantId, (tx) =>
    upsertSocialDraft(tx, {
      itemId: id,
      revisionId: rev.id,
      platform,
      body: result.body,
      hashtags: result.hashtags,
    }),
  )
  return json(200, { platform, body: result.body, hashtags: result.hashtags, model: result.model })
}
