import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { isStorageConfigured, copyObject, deleteObject, publicUrlForKey } from "@/lib/storage/s3"
import { isKnownFolderKey } from "@/lib/storage/keys"
import { findImageReferences } from "@/lib/content/media-usage"

export const runtime = "nodejs"

// POST /api/v1/media/move — renomeia (mesma pasta) ou move (outra pasta) uma
// imagem: copyObject + deleteObject. Guard de uso na origem: 409 {inUse} sem
// confirm. owner/admin.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  if (!isStorageConfigured()) return json(503, { error: "storage não configurado" })

  const body = (await req.json().catch(() => ({}))) as { srcKey?: string; destKey?: string; confirm?: boolean }
  const srcKey = body.srcKey ?? ""
  const destKey = body.destKey ?? ""
  if (!isKnownFolderKey(srcKey) || !isKnownFolderKey(destKey)) return json(400, { error: "chave inválida" })
  if (srcKey === destKey) return json(400, { error: "origem e destino iguais" })

  const refs = await findImageReferences(getDb(), a.tenantId, publicUrlForKey(a.tenantId, srcKey))
  if (refs.total > 0 && !body.confirm) return json(409, { inUse: refs })

  const url = await copyObject(a.tenantId, srcKey, destKey)
  await deleteObject(a.tenantId, srcKey)
  return json(200, { key: destKey, url })
}
