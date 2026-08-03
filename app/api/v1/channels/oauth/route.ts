import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { canOperate } from "@/lib/platform/gating"
import { PLATFORMS, type Platform } from "@/lib/channels/types"
import { isOAuthConfigured, authorizeUrl, exchangeCode } from "@/lib/channels/oauth"
import { storeChannelToken, ChannelLimitError } from "@/lib/channels/registry"

export const runtime = "nodejs"

function parsePlatform(v: string | null): Platform | null {
  return v && PLATFORMS.includes(v as Platform) ? (v as Platform) : null
}

// GET /api/v1/channels/oauth?platform=&state= — URL de autorização do provedor
// (o console redireciona o usuário). 409 se o app OAuth não está configurado (seam:
// o console cai no colar-JSON manual). owner/admin.
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const url = new URL(req.url)
  const platform = parsePlatform(url.searchParams.get("platform"))
  const state = (url.searchParams.get("state") ?? "").trim()
  if (!platform) return json(400, { error: "invalid platform" })
  if (!state) return json(400, { error: "state ausente" })
  if (!isOAuthConfigured(platform)) return json(409, { error: "oauth não configurado para este canal" })
  return json(200, { url: authorizeUrl(platform, state) })
}

// POST /api/v1/channels/oauth { platform, code } — troca o code do callback por um
// token e conecta o canal (grava credencial + expiry + refresh; respeita o limite do
// plano). owner/admin.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { platform?: string; code?: string }
  const platform = parsePlatform(body.platform ?? null)
  const code = (body.code ?? "").trim()
  if (!platform) return json(400, { error: "invalid platform" })
  if (!code) return json(400, { error: "code ausente" })
  if (!isOAuthConfigured(platform)) return json(409, { error: "oauth não configurado para este canal" })

  try {
    const token = await exchangeCode(platform, code)
    await storeChannelToken(sql, a.tenantId, platform, token)
  } catch (e) {
    if (e instanceof ChannelLimitError) return json(409, { error: e.message })
    return json(502, { error: e instanceof Error ? e.message : "falha na troca OAuth" })
  }
  return json(200, { ok: true })
}
