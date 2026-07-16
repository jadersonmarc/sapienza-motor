import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { publishItem } from "@/lib/channels/registry"
import { TransitionError } from "@/lib/content/state-machine"
import { generateAndStoreCover, isImageConfigured } from "@/lib/brand/social-image"

export const runtime = "nodejs"

// Lê o essencial da peça (sob withTenant) p/ gerar a capa on-brand antes de publicar.
async function coverInfo(sql: ReturnType<typeof getDb>, tenantId: string, id: string) {
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = (await tx`
      SELECT ci.slug, ci.pilar, ci.published_at, cr.title
        FROM content_items ci
        JOIN content_revisions cr ON cr.id = ci.current_revision_id
       WHERE ci.id = ${id}
    `) as unknown as { slug: string; pilar: string | null; published_at: string | null; title: string }[]
    return row ?? null
  })
}

// POST /api/v1/content/:id/publish — publica nos canais habilitados + transição→published
// (fatura 1 peça na 1ª vez). Aprovação manual antecipa a janela de 48h. Gera a imagem
// on-brand (Satori) e sobe no R2 quando o storage está configurado (URL pública p/ IG).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { imageUrl?: string }
  let imageUrl = body.imageUrl

  // Só gera a capa se o storage estiver configurado e a peça ainda não foi publicada
  // (republicar é idempotente — não re-renderiza nem re-posta).
  if (!imageUrl && isImageConfigured()) {
    const info = await coverInfo(sql, a.tenantId, id)
    if (info && info.published_at == null) {
      imageUrl = (await generateAndStoreCover({ slug: info.slug, title: info.title, pilar: info.pilar })) ?? undefined
    }
  }

  try {
    const results = await publishItem(sql, a.tenantId, id, undefined, imageUrl)
    return json(200, { published: results })
  } catch (e) {
    if (e instanceof TransitionError) return json(409, { error: e.message })
    throw e
  }
}
