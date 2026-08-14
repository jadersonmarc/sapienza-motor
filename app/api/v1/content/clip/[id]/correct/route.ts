import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import {
  getTranscript,
  updateTranscriptWords,
  listClipsForSource,
  getClipProps,
  updateClipPropsInPlace,
  setRenderStatus,
} from "@/lib/content/store"
import { applyWordCorrection } from "@/lib/ai/clip-analysis"
import type { ClipProps, TranscriptWord } from "@/lib/content/clip-types"
import { pokeClipWorker } from "../../poke"

export const runtime = "nodejs"

// POST /api/v1/content/clip/[id]/correct — corrige um termo (nome próprio, sigla,
// jargão que o STT errou) e PROPAGA para a transcrição e todos os clipes ainda não
// publicados do mesmo vídeo, re-renderizando-os (§3.3). [id] = fonte.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { from?: string; to?: string }
  const from = (body.from ?? "").trim()
  const to = (body.to ?? "").trim()
  if (!from || !to) return json(400, { error: "informe a palavra errada e a correção" })

  const result = await withTenant(sql, a.tenantId, async (tx) => {
    const t = await getTranscript(tx, id)
    if (!t) return { notFound: true as const }

    const tw = applyWordCorrection(t.words as TranscriptWord[], from, to)
    if (tw.count === 0) return { corrected: 0, requeued: 0 }
    await updateTranscriptWords(tx, id, tw.words)

    // Propaga para os clipes ainda editáveis (draft/in_review) e re-enfileira.
    const clips = await listClipsForSource(tx, id)
    let requeued = 0
    for (const c of clips) {
      if (c.status !== "draft" && c.status !== "in_review") continue
      const props = (await getClipProps(tx, c.id)) as ClipProps | null
      if (!props) continue
      const pw = applyWordCorrection(props.words, from, to)
      if (pw.count === 0) continue
      props.words = pw.words
      await updateClipPropsInPlace(tx, c.id, props as unknown as Record<string, unknown>)
      await setRenderStatus(tx, c.id, "queued")
      requeued++
    }
    return { corrected: tw.count, requeued }
  })

  if ("notFound" in result) return json(409, { error: "transcrição indisponível (expirada?)" })
  if (result.requeued > 0) await pokeClipWorker()
  return json(200, result)
}
