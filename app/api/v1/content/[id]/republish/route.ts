import { after } from "next/server"
import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import { retryFailedChannels, PartialPublishError } from "@/lib/channels/registry"
import { setPublishError } from "@/lib/content/store"

export const runtime = "nodejs"

// POST /api/v1/content/:id/republish — reprocessa APENAS os canais que falharam
// numa publicação anterior (a peça já está published). Não re-fatura nem republica
// onde já saiu. Roda em segundo plano (202) igual ao publish; atualiza publish_error
// (limpa se zerou, regrava só as falhas restantes). 409 se a peça não está publicada.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  // Só faz sentido reprocessar uma peça já publicada (síncrono → 409 claro).
  const [row] = (await withTenant(sql, a.tenantId, async (tx) =>
    tx`SELECT published_at FROM content_items WHERE id = ${id}`,
  )) as unknown as { published_at: string | null }[]
  if (!row) return json(404, { error: "peça não encontrada" })
  if (row.published_at == null) return json(409, { error: "peça ainda não foi publicada" })

  after(async () => {
    try {
      const { published, failures } = await retryFailedChannels(sql, a.tenantId, id)
      const msg = failures.length > 0 ? new PartialPublishError(published, failures).message : null
      await withTenant(sql, a.tenantId, (tx) => setPublishError(tx, id, msg))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[republish] falha em background (peça ${id}):`, msg)
      await withTenant(sql, a.tenantId, (tx) => setPublishError(tx, id, msg)).catch(() => {})
    }
  })

  return json(202, { async: true })
}
