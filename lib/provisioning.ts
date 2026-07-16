import type { Sql } from "@/lib/db"
import { applyTenantMigrations } from "@/lib/platform/tenancy"
import { tenantMigrations } from "@/lib/db/migrations"
import { cursor, fetchAfter, ack } from "@/lib/platform/events"
import { PRODUTO } from "@/lib/platform/gating"

// Escuta o outbox (public.event_outbox) via cursor (bus.event_cursors). Em
// SubscriptionActivated{motor}, aplica as migrations de tenant no schema tenant_<id>
// (o core já criou o schema vazio no provisioning). Idempotente.

/** Processa eventos novos do outbox; retorna quantos foram lidos. */
export async function processOutbox(sql: Sql): Promise<number> {
  const last = await cursor(sql)
  const events = await fetchAfter(sql, last, 200)
  if (events.length === 0) return 0
  const migrations = tenantMigrations()
  for (const e of events) {
    const produto = e.produto ?? (e.payload?.produto as string | undefined)
    if (e.type === "SubscriptionActivated" && produto === PRODUTO) {
      await applyTenantMigrations(sql, e.tenant_id, migrations)
    }
  }
  await ack(sql, events[events.length - 1].id)
  return events.length
}

/** Catch-up no boot: provisiona todos os tenants com assinatura motor ativa. */
export async function catchUp(sql: Sql): Promise<void> {
  const rows = (await sql`
    SELECT tenant_id FROM public.subscriptions WHERE produto = ${PRODUTO} AND status = 'active'
  `) as unknown as { tenant_id: string }[]
  const migrations = tenantMigrations()
  for (const r of rows) await applyTenantMigrations(sql, r.tenant_id, migrations)
}
