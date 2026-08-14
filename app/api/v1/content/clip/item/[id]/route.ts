import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate } from "@/lib/platform/gating"
import {
  getClipEditContext,
  updateClipPropsInPlace,
  setRenderStatus,
  getTranscript,
} from "@/lib/content/store"
import { sliceWords } from "@/lib/ai/clip-analysis"
import type { ClipProps, TranscriptWord } from "@/lib/content/clip-types"
import { pokeClipWorker } from "../../poke"

export const runtime = "nodejs"

const MAX_CLIP_MS = 300_000 // Onda 1: cortes até 5 min

type PatchBody = {
  inMs?: number
  outMs?: number
  aspect?: "9x16" | "16x9"
  crop?: { x: number; y: number; scale: number }
  brandOn?: boolean
  captionPosition?: "bottom" | "center" | "top"
}

// PATCH /api/v1/content/clip/item/[id] — editor-lite: reajusta o corte (in/out),
// aspecto, enquadramento, marca e posição da legenda; re-enfileira o render. Só
// antes de publicar. Reajustar in/out re-recorta as palavras da transcrição.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const { id } = await ctx.params
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as PatchBody

  const c = await withTenant(sql, a.tenantId, (tx) => getClipEditContext(tx, id))
  if (!c) return json(404, { error: "clipe não encontrado" })
  if (c.status !== "draft" && c.status !== "in_review") {
    return json(409, { error: "clipe já publicado/agendado — não dá para reajustar" })
  }
  const props = c.clip_props as ClipProps | null
  if (!props) return json(409, { error: "clipe sem propriedades de render" })

  const next: ClipProps = { ...props }
  if (body.aspect === "9x16" || body.aspect === "16x9") next.aspect = body.aspect
  if (typeof body.brandOn === "boolean") next.brandOn = body.brandOn
  if (body.crop) {
    const clamp = (v: number) => Math.min(1, Math.max(0, Number(v)))
    next.crop = { x: clamp(body.crop.x), y: clamp(body.crop.y), scale: Math.max(1, Number(body.crop.scale) || 1) }
  }
  if (body.captionPosition) next.caption = { ...next.caption, position: body.captionPosition }

  const inChanged = typeof body.inMs === "number" && body.inMs !== props.inMs
  const outChanged = typeof body.outMs === "number" && body.outMs !== props.outMs
  if (inChanged || outChanged) {
    const newIn = Math.max(0, Math.round(body.inMs ?? props.inMs))
    const newOut = Math.round(body.outMs ?? props.outMs)
    if (newOut <= newIn) return json(400, { error: "o fim do corte precisa ser depois do início" })
    if (newOut - newIn > MAX_CLIP_MS) return json(400, { error: "corte acima de 5 min (limite da Onda 1)" })
    if (!c.clip_source_id) return json(409, { error: "clipe sem fonte" })
    const t = await withTenant(sql, a.tenantId, (tx) => getTranscript(tx, c.clip_source_id as string))
    if (!t) return json(409, { error: "transcrição expirada — não é possível reajustar o corte" })
    next.inMs = newIn
    next.outMs = newOut
    next.words = sliceWords(t.words as TranscriptWord[], newIn, newOut)
  }

  await withTenant(sql, a.tenantId, async (tx) => {
    await updateClipPropsInPlace(tx, id, next as unknown as Record<string, unknown>)
    await setRenderStatus(tx, id, "queued") // re-render com as novas props
  })
  await pokeClipWorker()
  return json(200, { ok: true })
}
