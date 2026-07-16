import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { canOperate, channelLimit } from "@/lib/platform/gating"
import { enabledChannels, connectChannel, ChannelLimitError } from "@/lib/channels/registry"
import { PLATFORMS, type Platform } from "@/lib/channels/types"

export const runtime = "nodejs"

// GET /api/v1/channels — canais habilitados + limite do tier.
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const sql = getDb()
  const [channels, limit] = await Promise.all([
    enabledChannels(sql, a.tenantId),
    channelLimit(sql, a.tenantId),
  ])
  return json(200, {
    limit,
    channels: channels.map((c) => ({ platform: c.platform, enabled: c.enabled })),
  })
}

// POST /api/v1/channels — conecta/atualiza um canal (gate por tier).
// Grava credenciais do cliente (cifradas): exige owner/admin, não qualquer membro.
export async function POST(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied
  const sql = getDb()
  if (!(await canOperate(sql, a.tenantId))) return json(403, { error: "subscription not active" })

  const body = (await req.json().catch(() => ({}))) as { platform?: string; credentials?: string }
  const platform = body.platform as Platform | undefined
  if (!platform || !PLATFORMS.includes(platform)) return json(400, { error: "invalid platform" })
  try {
    await connectChannel(sql, a.tenantId, platform, body.credentials)
  } catch (e) {
    if (e instanceof ChannelLimitError) return json(409, { error: e.message })
    throw e
  }
  return json(200, { ok: true })
}
