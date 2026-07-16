import type { Sql } from "@/lib/db"

// Espelha sapienza-kit/gating: leitura READ-ONLY em `public` (subscriptions,
// memberships, product_rules). O Motor NUNCA escreve em public (exceto append no
// event_outbox, ver events.ts). produto fixo = "motor".

export const PRODUTO = "motor"
export type Tier = "start" | "pro" | "scale"

export type TenantAccess = {
  subscribed: boolean
  status: string
  tier: Tier | null
  hardCap: boolean
}

/** Assinatura do tenant para o Motor (sem usuário no contexto). */
export async function tenantAccess(sql: Sql, tenantId: string): Promise<TenantAccess> {
  const rows = (await sql`
    SELECT tier, status, COALESCE(hard_cap, false) AS hard_cap
    FROM public.subscriptions
    WHERE tenant_id = ${tenantId}::uuid AND produto = ${PRODUTO}
  `) as unknown as { tier: string; status: string; hard_cap: boolean }[]
  if (rows.length === 0) return { subscribed: false, status: "", tier: null, hardCap: false }
  const r = rows[0]
  return { subscribed: true, status: r.status, tier: r.tier as Tier, hardCap: r.hard_cap }
}

/** Pode operar = assinatura ativa. */
export async function canOperate(sql: Sql, tenantId: string): Promise<boolean> {
  const a = await tenantAccess(sql, tenantId)
  return a.subscribed && a.status === "active"
}

/** Tier ativo do Motor (null se não assina/ativo). */
export async function tierOf(sql: Sql, tenantId: string): Promise<Tier | null> {
  const a = await tenantAccess(sql, tenantId)
  return a.status === "active" ? a.tier : null
}

/** Tenants com assinatura Motor ativa (para varreduras dos crons). */
export async function activeTenants(sql: Sql): Promise<string[]> {
  const rows = (await sql`
    SELECT tenant_id FROM public.subscriptions
    WHERE produto = ${PRODUTO} AND status = 'active'
  `) as unknown as { tenant_id: string }[]
  return rows.map((r) => r.tenant_id)
}

/** Regras do produto (public.product_rules.rules jsonb), materializadas do pricing.yaml. */
export async function productRules(sql: Sql): Promise<Record<string, unknown>> {
  const rows = (await sql`
    SELECT rules FROM public.product_rules WHERE produto = ${PRODUTO}
  `) as unknown as { rules: Record<string, unknown> }[]
  return rows[0]?.rules ?? {}
}

/** Nº de canais incluídos no tier ativo (public.plans.canais). 0 se não assina. */
export async function channelLimit(sql: Sql, tenantId: string): Promise<number> {
  const tier = await tierOf(sql, tenantId)
  if (!tier) return 0
  const rows = (await sql`
    SELECT COALESCE(canais, 0) AS canais FROM public.plans WHERE produto = ${PRODUTO} AND tier = ${tier}
  `) as unknown as { canais: number }[]
  return rows[0]?.canais ?? 0
}
