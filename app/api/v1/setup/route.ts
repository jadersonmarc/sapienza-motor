import { authed, isResponse, json } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { tenantAccess, channelLimit } from "@/lib/platform/gating"
import { enabledChannels } from "@/lib/channels/registry"
import { PLATFORMS } from "@/lib/channels/types"

export const runtime = "nodejs"

// Credenciais pedidas por canal no onboarding (mockadas em teste).
const REQUIRED_CREDENTIALS: Record<string, string[]> = {
  instagram: ["access_token", "account_id"],
  linkedin: ["access_token", "author_urn"],
  blog: [],
  facebook: ["access_token", "page_id"],
  twitter: ["access_token", "username"],
  threads: ["access_token", "user_id"],
  wordpress: ["site_url", "username", "app_password"],
  webhook: ["url", "secret"],
}

// GET /api/v1/setup — status de onboarding: assinatura, capacidade de canais e o que falta.
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const sql = getDb()

  const access = await tenantAccess(sql, a.tenantId)
  if (!access.subscribed || access.status !== "active") {
    return json(200, {
      active: false,
      tier: access.tier,
      channelLimit: 0,
      connected: [],
      available: PLATFORMS.map((p) => ({ platform: p, requires: REQUIRED_CREDENTIALS[p] })),
    })
  }

  const [limit, connected] = await Promise.all([
    channelLimit(sql, a.tenantId),
    enabledChannels(sql, a.tenantId),
  ])
  const connectedSet = new Set(connected.map((c) => c.platform))

  return json(200, {
    active: true,
    tier: access.tier,
    channelLimit: limit,
    slotsUsed: connected.length,
    slotsRemaining: Math.max(0, limit - connected.length),
    connected: connected.map((c) => c.platform),
    available: PLATFORMS.filter((p) => !connectedSet.has(p)).map((p) => ({
      platform: p,
      requires: REQUIRED_CREDENTIALS[p],
    })),
  })
}
