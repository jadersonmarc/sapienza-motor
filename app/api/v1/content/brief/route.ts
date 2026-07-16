import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { createItem } from "@/lib/content/store"
import { generateFromBrief } from "@/lib/ai/brief"
import { slugify } from "@/lib/content/slug"

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

  const draft = await generateFromBrief({
    objetivo,
    pontosChave: body.pontosChave,
    publico: body.publico,
    tom: body.tom,
    pilar: body.pilar ?? null,
  })
  const slug = `${draft.slug || slugify(objetivo) || "rascunho"}-${Date.now().toString(36)}`
  const item = await withTenant(sql, a.tenantId, (tx) =>
    createItem(tx, {
      slug,
      title: draft.title,
      bodyMarkdown: draft.bodyMarkdown,
      excerpt: draft.excerpt,
      pilar: body.pilar ?? null,
      seo: draft.keywords.length ? { keywords: draft.keywords } : undefined,
      authorId: a.userId,
    }),
  )
  return json(201, { id: item.id, slug })
}
