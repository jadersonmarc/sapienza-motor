import { json } from "@/lib/api/http"
import { cronAuthorized } from "@/lib/platform/webhook"
import { getDb } from "@/lib/db"
import { processOutbox } from "@/lib/provisioning"

export const runtime = "nodejs"

// POST /api/cron/provision — drena o outbox (SubscriptionActivated{motor} → migrations
// de tenant). Complementa o catch-up de boot para ativações posteriores. Protegido por secret.
export async function POST(req: Request): Promise<Response> {
  if (!cronAuthorized(req)) return json(401, { error: "unauthorized" })
  const sql = getDb()
  let drained = 0
  for (;;) {
    const n = await processOutbox(sql)
    drained += n
    if (n === 0) break
  }
  return json(200, { drained })
}
