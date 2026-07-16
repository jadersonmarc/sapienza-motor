import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { createItem, listItems } from "@/lib/content/store"
import { generateDraft } from "@/lib/ai/generate"
import { slugify } from "@/lib/content/slug"

export const runtime = "nodejs"

// GET /api/v1/content — lista as peças do tenant.
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const sql = getDb()
  const items = await withTenant(sql, a.tenantId, (tx) => listItems(tx))
  return json(200, { items })
}

// POST /api/v1/content — cria uma peça a partir de um tema (gera rascunho via IA/seam).
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { prompt?: string }
  const prompt = (body.prompt ?? "").trim()
  if (!prompt) return json(400, { error: "prompt required" })

  const draft = await generateDraft(prompt)
  const slug = `${draft.slug || slugify(prompt)}-${Date.now().toString(36)}`
  const item = await withTenant(sql, a.tenantId, (tx) =>
    createItem(tx, {
      slug,
      title: draft.title,
      bodyMarkdown: draft.bodyMarkdown,
      excerpt: draft.excerpt,
      seo: draft.keywords.length ? { keywords: draft.keywords } : undefined,
      authorId: a.userId,
    }),
  )
  return json(201, { id: item.id, slug })
}
