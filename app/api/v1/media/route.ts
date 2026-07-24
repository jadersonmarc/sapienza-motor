import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { canOperate, storageQuotaMb } from "@/lib/platform/gating"
import {
  isStorageConfigured,
  listObjects,
  uploadObject,
  deleteObject,
  usedBytes,
  publicUrlForKey,
} from "@/lib/storage/s3"
import {
  isR2Purpose,
  isKnownFolderKey,
  listPrefixFor,
  mediaUploadKey,
  editorUploadKey,
  type R2Purpose,
} from "@/lib/storage/keys"
import { findImageReferences } from "@/lib/content/media-usage"
import { randomUUID } from "node:crypto"

export const runtime = "nodejs"

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

// GET /api/v1/media?folder=&token= — lista uma pasta/canal do bucket do tenant.
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  if (!isStorageConfigured()) return json(503, { error: "storage não configurado" })

  const sp = new URL(req.url).searchParams
  const folder = sp.get("folder") ?? ""
  if (!isR2Purpose(folder)) return json(400, { error: "pasta inválida" })
  const token = sp.get("token") ?? undefined

  const { objects, nextToken } = await listObjects(a.tenantId, listPrefixFor(folder), { token })
  const quotaMb = await storageQuotaMb(getDb(), a.tenantId)
  const used = await usedBytes(a.tenantId)
  return json(200, { objects, nextToken, quota: { usedBytes: used, quotaMb } })
}

// POST /api/v1/media (multipart) — upload de imagem numa pasta. owner/admin.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })
  if (!isStorageConfigured()) return json(503, { error: "storage não configurado" })

  const form = await req.formData()
  const file = form.get("file")
  if (!(file instanceof File)) return json(400, { error: "arquivo ausente" })
  if (!EXT[file.type]) return json(400, { error: "tipo de imagem não suportado" })
  if (file.size > MAX_BYTES) return json(400, { error: "imagem maior que 5 MB" })

  const folderRaw = String(form.get("folder") ?? "")
  const folder: R2Purpose | null = isR2Purpose(folderRaw) ? folderRaw : null

  // Cota do plano: barra se o upload estouraria o espaço do tier.
  const quotaMb = await storageQuotaMb(sql, a.tenantId)
  const used = await usedBytes(a.tenantId)
  if (used + file.size > quotaMb * 1024 * 1024) {
    return json(413, { error: `cota de ${quotaMb} MB do plano atingida` })
  }

  const ext = EXT[file.type]
  const key = folder
    ? mediaUploadKey({ purpose: folder, uuid: randomUUID(), ext })
    : editorUploadKey({ uuid: randomUUID(), ext })
  const buffer = Buffer.from(await file.arrayBuffer())
  const url = await uploadObject(a.tenantId, key, buffer, file.type)
  return json(201, { key, url })
}

// DELETE /api/v1/media?key=&confirm=1 — exclui; 409 {inUse} se referenciada.
export async function DELETE(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  if (!isStorageConfigured()) return json(503, { error: "storage não configurado" })

  const sp = new URL(req.url).searchParams
  const key = sp.get("key") ?? ""
  if (!isKnownFolderKey(key)) return json(400, { error: "imagem inválida" })
  const confirm = sp.get("confirm") === "1"

  const refs = await findImageReferences(getDb(), a.tenantId, publicUrlForKey(a.tenantId, key))
  if (refs.total > 0 && !confirm) return json(409, { inUse: refs })
  await deleteObject(a.tenantId, key)
  return json(200, { ok: true })
}
