import type { Sql } from "@/lib/db"
import { PRODUTO, tierOf, tenantAccess, clipperHours } from "@/lib/platform/gating"
import { emitUsageRecorded } from "@/lib/platform/events"
import { currentPeriod } from "@/lib/platform/period"

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
// Minutos de vídeo-fonte processados pelo Clipper. LIMITE OPERACIONAL, não fatura
// (SPEC §5.2): vai a usage_counters pela mesma via (outbox→trigger) para instrumentar
// e ser verificado na aceitação do job, mas o fechamento do core ignora (junta só
// plans.metric='peca'). O teto vem de product_rules.clipper_hours (horas × 60).
export const METRIC_CLIPPER_MINUTOS = "clipper_minutos"

export class GenerationQuotaError extends Error {}
export class PublishCapError extends Error {}
export class ClipperHoursError extends Error {}

// currentPeriod (BRT) vem de @/lib/platform/period — reexportado por compat com
// quem já importava daqui.
export { currentPeriod }

/** Incluído no tier ativo (public.plans.incluso). 0 se não assina/ativo. */
export async function planIncluso(sql: Sql, tenantId: string): Promise<number> {
  const tier = await tierOf(sql, tenantId)
  if (!tier) return 0
  // Uma linha por modelo (anual/mensal); `incluso` é idêntico — LIMIT 1.
  const rows = (await sql`
    SELECT COALESCE(incluso, 0) AS incluso FROM public.plans
     WHERE produto = ${PRODUTO} AND tier = ${tier} LIMIT 1
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

// ── Cota operacional de horas do Clipper (SPEC §5.2) ──────────────────────────
// NÃO é métrica de fatura: é um teto para proteger a FILA. Verificado na aceitação
// do job (após o probe dar a duração), com hard cap sempre — nunca processa para
// cobrar depois. Sem venda de excedente na Onda 1. Emite minutos ao outbox só para
// instrumentação (calibra o número). Refund em falha de ingestão (§7).

/** Uso e teto de minutos de vídeo no período corrente (para UI e cheque). */
export async function clipHoursQuota(
  sql: Sql,
  tenantId: string,
): Promise<{ usedMinutes: number; limitMinutes: number; remainingMinutes: number }> {
  const [used, hours] = await Promise.all([
    usageOf(sql, tenantId, METRIC_CLIPPER_MINUTOS),
    clipperHours(sql, tenantId),
  ])
  const limitMinutes = Math.round(hours * 60)
  return { usedMinutes: used, limitMinutes, remainingMinutes: Math.max(0, limitMinutes - used) }
}

/**
 * Debita `minutes` da cota de horas do Clipper ao ACEITAR o job (após o probe).
 * Lança ClipperHoursError se estourar o teto — a ingestão é bloqueada, nunca
 * processada para cobrar depois. Advisory lock serializa o mesmo tenant. Se a
 * ingestão falhar depois, chame refundClipHours(minutes).
 */
export async function reserveClipHours(sql: Sql, tenantId: string, minutes: number): Promise<void> {
  const limitMinutes = Math.round((await clipperHours(sql, tenantId)) * 60)
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`clipper:${tenantId}`}))`
    const rows = (await tx`
      SELECT count FROM public.usage_counters
       WHERE tenant_id = ${tenantId}::uuid AND produto = ${PRODUTO}
         AND period = ${currentPeriod()} AND metric = ${METRIC_CLIPPER_MINUTOS}
    `) as unknown as { count: number }[]
    const used = rows[0]?.count ?? 0
    if (used + minutes > limitMinutes) {
      const restanteH = Math.max(0, (limitMinutes - used) / 60)
      throw new ClipperHoursError(
        `cota de horas de vídeo do plano atingida (${(used / 60).toFixed(1)}h/${(limitMinutes / 60).toFixed(1)}h neste mês; ` +
          `restam ${restanteH.toFixed(1)}h). Faça upgrade para processar mais vídeo.`,
      )
    }
    await emitUsageRecorded(tx, {
      tenantId,
      metric: METRIC_CLIPPER_MINUTOS,
      count: minutes,
      period: currentPeriod(),
    })
  })
}

/** Estorna minutos reservados de uma ingestão que não se concretizou (§7). */
export async function refundClipHours(sql: Sql, tenantId: string, minutes: number): Promise<void> {
  if (minutes <= 0) return
  await sql.begin(async (tx) => {
    await emitUsageRecorded(tx, {
      tenantId,
      metric: METRIC_CLIPPER_MINUTOS,
      count: -minutes,
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
