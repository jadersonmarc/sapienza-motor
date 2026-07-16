import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { canOperate } from "@/lib/platform/gating"
import { contentTransition } from "@/lib/content/transition"
import { TransitionError, type ContentStatus } from "@/lib/content/state-machine"

export const runtime = "nodejs"

// POST /api/v1/content/:id/transition — { to, scheduledAt? }
// Publica via /publish (que aciona os canais); aqui é a transição de estado pura
// (in_review / scheduled / draft / archived / published sem canais).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { to?: string; scheduledAt?: string; note?: string }
  const to = body.to as ContentStatus | undefined
  if (!to) return json(400, { error: "to required" })
  try {
    await contentTransition(sql, a.tenantId, id, to, {
      actorId: a.userId,
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
      note: body.note?.trim() || undefined,
    })
  } catch (e) {
    if (e instanceof TransitionError) return json(409, { error: e.message })
    throw e
  }
  return json(200, { ok: true })
}
