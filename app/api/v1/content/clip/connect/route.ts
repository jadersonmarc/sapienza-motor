import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { encryptSecret } from "@/lib/platform/crypto"
import { saveClipConnector } from "@/lib/content/store"
import {
  type CloudProvider,
  authorizeUrl,
  isConnectorConfigured,
  exchangeCode,
} from "@/lib/content/clip-connectors"

export const runtime = "nodejs"

function asProvider(v: string): CloudProvider | null {
  return v === "gdrive" || v === "dropbox" ? v : null
}

// GET /api/v1/content/clip/connect?provider=&state= — URL de autorização OAuth do
// provedor de nuvem (o console redireciona o usuário). 503 se o app não está
// configurado (seam → só import por link).
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const sp = new URL(req.url).searchParams
  const provider = asProvider(sp.get("provider") ?? "")
  const state = sp.get("state") ?? ""
  if (!provider) return json(400, { error: "provider inválido" })
  if (!isConnectorConfigured(provider)) return json(503, { error: "conector não configurado" })
  return json(200, { url: authorizeUrl(provider, state) })
}

// POST /api/v1/content/clip/connect { provider, code } — troca o code do callback
// por token e grava cifrado (access + refresh + validade) para o tenant.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as { provider?: string; code?: string }
  const provider = asProvider(body.provider ?? "")
  const code = (body.code ?? "").trim()
  if (!provider || !code) return json(400, { error: "provider/code obrigatórios" })
  if (!isConnectorConfigured(provider)) return json(503, { error: "conector não configurado" })

  const t = await exchangeCode(provider, code)
  await withTenant(getDb(), a.tenantId, (tx) =>
    saveClipConnector(tx, {
      provider,
      credentialsEnc: encryptSecret(t.accessToken),
      refreshEnc: t.refreshToken ? encryptSecret(t.refreshToken) : null,
      expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
    }),
  )
  return json(200, { ok: true })
}
