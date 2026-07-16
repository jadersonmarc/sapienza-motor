import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { canOperate } from "@/lib/platform/gating"
import { publishItem } from "@/lib/channels/registry"
import { TransitionError } from "@/lib/content/state-machine"

export const runtime = "nodejs"

// POST /api/v1/content/:id/publish — publica nos canais habilitados + transição→published
// (fatura 1 peça na 1ª vez). Aprovação manual antecipa a janela de 48h.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { imageUrl?: string }
  try {
    const results = await publishItem(sql, a.tenantId, id, undefined, body.imageUrl)
    return json(200, { published: results })
  } catch (e) {
    if (e instanceof TransitionError) return json(409, { error: e.message })
    throw e
  }
}
