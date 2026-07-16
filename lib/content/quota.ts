import type { Sql } from "@/lib/db"
import { PRODUTO, tierOf, tenantAccess } from "@/lib/platform/gating"
import { emitUsageRecorded } from "@/lib/platform/events"

// Teto de CUSTO do produto. `plans.incluso` protegia só a receita: faturamos por
// peça publicada, mas gerar era ilimitado — um tenant podia queimar centenas de
// chamadas ao modelo e publicar 12. Aqui a geração passa a consumir cota igual à
// de publicação do plano (start 12 / pro 30 / scale 60).
//
// A cota vive em `usage_counters` com metric='geracao', pela mesma via do uso
// faturável (append no event_outbox → trigger do core agrega). NÃO entra na
// fatura: o fechamento junta usage_counters por `uc.metric = plans.metric`, e o
// metric do plano é 'peca' (core/lib/billing/close.ts). Contamos sem cobrar.
//
// Regeneração não consome desta cota — segue limitada a 2/peça (regenerate.ts).

export const METRIC_GERACAO = "geracao"
export const METRIC_PECA = "peca"

export class GenerationQuotaError extends Error {}
export class PublishCapError extends Error {}

/** Período corrente "YYYY-MM" — mesma convenção do billing e do trigger. */
export function currentPeriod(at = new Date()): string {
  return at.toISOString().slice(0, 7)
}

/** Incluído no tier ativo (public.plans.incluso). 0 se não assina/ativo. */
export async function planIncluso(sql: Sql, tenantId: string): Promise<number> {
  const tier = await tierOf(sql, tenantId)
  if (!tier) return 0
  const rows = (await sql`
    SELECT COALESCE(incluso, 0) AS incluso FROM public.plans
     WHERE produto = ${PRODUTO} AND tier = ${tier}
  `) as unknown as { incluso: number }[]
  return rows[0]?.incluso ?? 0
}

/** Uso do período corrente para uma métrica (0 se ainda não houve nenhum). */
export async function usageOf(sql: Sql, tenantId: string, metric: string): Promise<number> {
  const rows = (await sql`
    SELECT count FROM public.usage_counters
     WHERE tenant_id = ${tenantId}::uuid AND produto = ${PRODUTO}
       AND period = ${currentPeriod()} AND metric = ${metric}
  `) as unknown as { count: number }[]
  return rows[0]?.count ?? 0
}

export type QuotaStatus = { used: number; limit: number; remaining: number }

/** Quanto resta da cota de geração no período (para UI/diagnóstico). */
export async function generationQuota(sql: Sql, tenantId: string): Promise<QuotaStatus> {
  const [used, limit] = await Promise.all([
    usageOf(sql, tenantId, METRIC_GERACAO),
    planIncluso(sql, tenantId),
  ])
  return { used, limit, remaining: Math.max(0, limit - used) }
}

/**
 * Debita uma geração ANTES de chamar o modelo. Lança GenerationQuotaError se a
 * cota do plano acabou.
 *
 * Reservar antes é o ponto: o custo é a chamada ao modelo, então verificar depois
 * não protegeria nada. O advisory lock serializa os debitos do mesmo tenant, para
 * N requests simultâneos não passarem todos pela mesma leitura (o TOCTOU que
 * ainda existe em regenerate.ts). É lock, não escrita: a regra "só o core escreve
 * em public" continua valendo — o incremento sai do trigger, via outbox.
 *
 * Se a geração falhar depois disto, chame refundGeneration.
 */
export async function reserveGeneration(sql: Sql, tenantId: string): Promise<void> {
  const limit = await planIncluso(sql, tenantId)
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`geracao:${tenantId}`}))`
    const rows = (await tx`
      SELECT count FROM public.usage_counters
       WHERE tenant_id = ${tenantId}::uuid AND produto = ${PRODUTO}
         AND period = ${currentPeriod()} AND metric = ${METRIC_GERACAO}
    `) as unknown as { count: number }[]
    const used = rows[0]?.count ?? 0
    if (used >= limit) {
      throw new GenerationQuotaError(
        `cota de geração do plano atingida (${used}/${limit} neste mês); publique o que já foi gerado ou faça upgrade`,
      )
    }
    await emitUsageRecorded(tx, {
      tenantId,
      metric: METRIC_GERACAO,
      count: 1,
      period: currentPeriod(),
    })
  })
}

/**
 * Devolve uma geração reservada que não se concretizou (erro do modelo, etc).
 * O trigger do core soma `count + EXCLUDED.count`, então -1 decrementa — o
 * cliente não perde cota por falha nossa.
 */
export async function refundGeneration(sql: Sql, tenantId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await emitUsageRecorded(tx, {
      tenantId,
      metric: METRIC_GERACAO,
      count: -1,
      period: currentPeriod(),
    })
  })
}

/**
 * Bloqueia publicação quando o tenant tem hard_cap e já atingiu o incluído.
 * Espelha core/lib/billing/compute.ts::blockedByCap (hardCap && count >= incluso)
 * — o Motor não pode importar do core, mesma situação de overage/invoiceLine.
 *
 * Precisa rodar ANTES de postar nos canais: dentro de contentTransition seria
 * tarde, o post externo já teria saído.
 */
export async function assertPublishAllowed(sql: Sql, tenantId: string): Promise<void> {
  const access = await tenantAccess(sql, tenantId)
  if (!access.hardCap) return // soft: excedente é faturado, não bloqueado
  const [used, incluso] = await Promise.all([
    usageOf(sql, tenantId, METRIC_PECA),
    planIncluso(sql, tenantId),
  ])
  if (used >= incluso) {
    throw new PublishCapError(
      `cap rígido atingido (${used}/${incluso} peças neste mês); novas publicações liberam no próximo ciclo ou com upgrade`,
    )
  }
}
