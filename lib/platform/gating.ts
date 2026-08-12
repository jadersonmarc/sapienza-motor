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
  // plans tem uma linha por MODELO (anual/mensal); o limite de canais é idêntico
  // nos dois — LIMIT 1 evita duplicar sem depender do modelo do tenant.
  const rows = (await sql`
    SELECT COALESCE(canais, 0) AS canais FROM public.plans
     WHERE produto = ${PRODUTO} AND tier = ${tier} LIMIT 1
  `) as unknown as { canais: number }[]
  return rows[0]?.canais ?? 0
}

// Cota da biblioteca de mídia (MB) por tier — cresce com o plano. Vem de
// product_rules.rules.storage_mb = { start, pro, scale }. Fallback conservador
// se as regras ainda não foram materializadas (pnpm pricing:sync).
const DEFAULT_STORAGE_MB = 500

export async function storageQuotaMb(sql: Sql, tenantId: string): Promise<number> {
  const tier = await tierOf(sql, tenantId)
  if (!tier) return 0
  const rules = await productRules(sql)
  const map = rules.storage_mb
  if (map && typeof map === "object") {
    const v = (map as Record<string, unknown>)[tier]
    if (typeof v === "number") return v
  }
  return DEFAULT_STORAGE_MB
}

// Capability de MOTION (vídeo animado) por tier — diferencial dos planos Pro e
// Premium. Vem de product_rules.rules.motion_enabled = { start, pro, scale } (1 =
// libera). Fallback conservador (false) se as regras ainda não foram materializadas
// (pnpm pricing:sync) — nunca chutar liberado.
export async function motionEnabled(sql: Sql, tenantId: string): Promise<boolean> {
  const tier = await tierOf(sql, tenantId)
  if (!tier) return false
  const rules = await productRules(sql)
  const map = rules.motion_enabled
  if (map && typeof map === "object") {
    const v = (map as Record<string, unknown>)[tier]
    if (typeof v === "number") return v === 1
    if (typeof v === "boolean") return v
  }
  return false
}

// Peso de uma peça de motion na cota de peça publicada. Vem de
// product_rules.rules.motion_weight (escalar). Default 1 = conta como qualquer
// outra peça (é o valor de lançamento). Nunca chutar > 1.
export async function motionWeight(sql: Sql): Promise<number> {
  const rules = await productRules(sql)
  const w = rules.motion_weight
  return typeof w === "number" && w > 0 ? w : 1
}

// Capability do CLIPPER (Clipes Inteligentes) por tier — espelha motion_enabled.
// Vem de product_rules.rules.clipper_enabled = { start, pro, scale } (1 = libera).
// Fallback conservador (false) — nunca chutar liberado.
export async function clipperEnabled(sql: Sql, tenantId: string): Promise<boolean> {
  const tier = await tierOf(sql, tenantId)
  if (!tier) return false
  const rules = await productRules(sql)
  const map = rules.clipper_enabled
  if (map && typeof map === "object") {
    const v = (map as Record<string, unknown>)[tier]
    if (typeof v === "number") return v === 1
    if (typeof v === "boolean") return v
  }
  return false
}

// LIMITE OPERACIONAL de horas de vídeo-fonte por ciclo (SPEC §5.2) — NÃO é métrica
// de fatura, é teto para proteger a fila. Vem de product_rules.rules.clipper_hours =
// { start, pro, scale } (horas). Fallback 0 = bloqueia (não chutar liberado). 0 no
// plano também bloqueia — coerente com "clipper indisponível".
export async function clipperHours(sql: Sql, tenantId: string): Promise<number> {
  const tier = await tierOf(sql, tenantId)
  if (!tier) return 0
  const rules = await productRules(sql)
  const map = rules.clipper_hours
  if (map && typeof map === "object") {
    const v = (map as Record<string, unknown>)[tier]
    if (typeof v === "number" && v >= 0) return v
  }
  return 0
}
