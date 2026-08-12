import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { canOperate, clipperEnabled } from "@/lib/platform/gating"
import { clipHoursQuota } from "@/lib/content/quota"
import { createClipSource } from "@/lib/content/store"
import { isStorageConfigured, uploadObject } from "@/lib/storage/s3"
import { clipRawKey } from "@/lib/storage/keys"
import { pokeClipWorker } from "../poke"

export const runtime = "nodejs"

// Onda 1: upload direto pela app (bufferizado). Vídeos grandes devem vir por URL
// (o worker baixa via yt-dlp em disco). Presigned direto-ao-R2 fica p/ evolução.
const MAX_BYTES = 500 * 1024 * 1024 // 500 MB
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]

// POST /api/v1/content/clip/upload (multipart) — envia um arquivo de vídeo local.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })
  if (!(await clipperEnabled(sql, a.tenantId))) {
    return json(403, { error: "Clipes Inteligentes não disponível no seu plano" })
  }
  if (!isStorageConfigured()) return json(503, { error: "storage não configurado" })

  const quota = await clipHoursQuota(sql, a.tenantId)
  if (quota.remainingMinutes <= 0) {
    return json(409, { error: "cota de horas de vídeo do plano esgotada neste mês; faça upgrade" })
  }

  const form = await req.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return json(400, { error: "arquivo ausente" })
  if (file.type && !VIDEO_TYPES.includes(file.type)) {
    return json(400, { error: "formato de vídeo não suportado (use MP4, MOV, WEBM ou MKV)" })
  }
  if (file.size > MAX_BYTES) {
    return json(413, { error: "arquivo acima de 500 MB — importe por URL para vídeos maiores" })
  }

  // Cria a fonte primeiro (para ter o id) e sobe o bruto na chave determinística que
  // o pipeline resolve (clipRawKey por sourceId). Formato lido do conteúdo, não da
  // extensão — a chave usa .mp4 mesmo que o upload seja .mov.
  const source = await withTenant(sql, a.tenantId, (tx) =>
    createClipSource(tx, { kind: "upload", origin: file.name || "upload", authorId: a.userId }),
  )
  const key = clipRawKey({ sourceId: source.id, ext: "mp4" })
  const buffer = Buffer.from(await file.arrayBuffer())
  await uploadObject(a.tenantId, key, buffer, file.type || "video/mp4")

  await pokeClipWorker()
  return json(202, { id: source.id, status: source.status })
}
