import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { encryptSecret, decryptSecret } from "@/lib/platform/crypto"
import { canOperate, clipperEnabled } from "@/lib/platform/gating"
import { clipHoursQuota } from "@/lib/content/quota"
import { createClipSource, getClipConnector, saveClipConnector } from "@/lib/content/store"
import { isStorageConfigured, uploadObject } from "@/lib/storage/s3"
import { clipRawKey } from "@/lib/storage/keys"
import { type CloudProvider, downloadFile, refresh, isConnectorConfigured } from "@/lib/content/clip-connectors"
import { pokeClipWorker } from "../poke"
import { randomUUID } from "node:crypto"

export const runtime = "nodejs"

const MAX_BYTES = 500 * 1024 * 1024

function asProvider(v: string): CloudProvider | null {
  return v === "gdrive" || v === "dropbox" ? v : null
}

// POST /api/v1/content/clip/import { provider, fileRef } — baixa o vídeo da conta de
// nuvem conectada (com refresh do token se preciso) e o injeta na esteira do Clipper.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })
  if (!(await clipperEnabled(sql, a.tenantId))) return json(403, { error: "Clipes Inteligentes não disponível no seu plano" })
  if (!isStorageConfigured()) return json(503, { error: "storage não configurado" })

  const body = (await req.json().catch(() => ({}))) as { provider?: string; fileRef?: string }
  const provider = asProvider(body.provider ?? "")
  const fileRef = (body.fileRef ?? "").trim()
  if (!provider || !fileRef) return json(400, { error: "provider/fileRef obrigatórios" })
  if (!isConnectorConfigured(provider)) return json(503, { error: "conector não configurado" })

  const quota = await clipHoursQuota(sql, a.tenantId)
  if (quota.remainingMinutes <= 0) return json(409, { error: "cota de horas de vídeo esgotada; faça upgrade" })

  const conn = await withTenant(sql, a.tenantId, (tx) => getClipConnector(tx, provider))
  if (!conn || !conn.credentials_enc) return json(409, { error: "conecte a conta antes de importar" })

  // Token válido? Se expirou e há refresh, renova e regrava.
  let accessToken = decryptSecret(conn.credentials_enc)
  const expired = conn.expires_at ? new Date(conn.expires_at).getTime() < Date.now() + 30_000 : false
  if (expired && conn.refresh_enc) {
    const t = await refresh(provider, decryptSecret(conn.refresh_enc))
    accessToken = t.accessToken
    await withTenant(sql, a.tenantId, (tx) =>
      saveClipConnector(tx, {
        provider,
        credentialsEnc: encryptSecret(t.accessToken),
        refreshEnc: encryptSecret(t.refreshToken ?? decryptSecret(conn.refresh_enc as string)),
        expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
      }),
    )
  }

  let buf: Buffer
  try {
    buf = await downloadFile(provider, accessToken, fileRef)
  } catch (e) {
    return json(502, { error: e instanceof Error ? e.message : "falha ao baixar da nuvem" })
  }
  if (buf.byteLength > MAX_BYTES) return json(413, { error: "arquivo acima de 500 MB — use importação por URL" })

  // Mesma regra do upload: R2 primeiro, depois a fonte já com r2_key_raw.
  const key = clipRawKey({ ref: randomUUID(), ext: "mp4" })
  await uploadObject(a.tenantId, key, buf, "video/mp4")
  const source = await withTenant(sql, a.tenantId, (tx) =>
    createClipSource(tx, { kind: "upload", origin: `${provider}:${fileRef}`, authorId: a.userId, r2KeyRaw: key }),
  )
  await pokeClipWorker()
  return json(202, { id: source.id })
}
