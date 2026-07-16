import type { Sql } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { productRules } from "@/lib/platform/gating"
import { emitUsageRecorded } from "@/lib/platform/events"
import { canTransition, TransitionError, type ContentStatus } from "./state-machine"
import { getItem, insertAudit } from "./store"

// Único ponto de mudança de status (grava audit_log; efeitos por destino). Adaptado
// de spa-sapienza/lib/content/transition.ts + regras da plataforma:
//  - in_review  → grava review_deadline_at (janela de aprovação; silêncio = aprovado)
//  - scheduled  → exige scheduledAt futuro
//  - published  → seta published_at UMA vez e, na 1ª publicação, fatura 1 "peca"
//                 (emitUsageRecorded na MESMA tx; trigger do core agrega usage_counters)

const DEFAULT_REVIEW_HOURS = 48

export type TransitionOpts = { actorId?: string | null; scheduledAt?: Date; note?: string | null }

export async function contentTransition(
  sql: Sql,
  tenantId: string,
  itemId: string,
  to: ContentStatus,
  opts: TransitionOpts = {},
): Promise<void> {
  const rules = await productRules(sql)
  const reviewHours = Number(rules["janela_aprovacao_horas"] ?? DEFAULT_REVIEW_HOURS)

  await withTenant(sql, tenantId, async (tx) => {
    const item = await getItem(tx, itemId)
    if (!item) throw new TransitionError("peça não encontrada")
    if (item.status === to) return
    if (!canTransition(item.status, to)) {
      throw new TransitionError(`transição inválida: ${item.status} → ${to}`)
    }

    if (to === "in_review") {
      const deadline = new Date(Date.now() + reviewHours * 3600_000)
      await tx`UPDATE content_items SET status='in_review', review_deadline_at=${deadline}, updated_at=now() WHERE id=${itemId}`
    } else if (to === "scheduled") {
      if (!opts.scheduledAt || opts.scheduledAt.getTime() <= Date.now()) {
        throw new TransitionError("scheduled exige scheduledAt no futuro")
      }
      await tx`UPDATE content_items SET status='scheduled', scheduled_at=${opts.scheduledAt}, updated_at=now() WHERE id=${itemId}`
    } else if (to === "published") {
      const firstPublish = item.published_at == null
      await tx`UPDATE content_items SET status='published', published_at=COALESCE(published_at, now()), updated_at=now() WHERE id=${itemId}`
      if (firstPublish) {
        const period = new Date().toISOString().slice(0, 7)
        await emitUsageRecorded(tx, { tenantId, metric: "peca", count: 1, period })
      }
    } else if (to === "draft") {
      // Voltar a rascunho (ex.: rejeição) reseta o agendamento e a janela de aprovação,
      // tirando a peça do caminho de auto-publicação dos crons.
      await tx`UPDATE content_items SET status='draft', review_deadline_at=NULL, scheduled_at=NULL, updated_at=now() WHERE id=${itemId}`
    } else {
      await tx`UPDATE content_items SET status=${to}, updated_at=now() WHERE id=${itemId}`
    }

    await insertAudit(tx, { itemId, actorId: opts.actorId, from: item.status, to, note: opts.note })
  })
}
