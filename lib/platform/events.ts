import type { Sql, Tx } from "@/lib/db"
import { PRODUTO } from "@/lib/platform/gating"

// Espelha sapienza-kit/events + core/lib/events/emit.ts. A ÚNICA escrita
// sancionada do Motor em `public` é o append no event_outbox (reportar uso). O
// cursor do consumer vive no schema `bus` (não em public). JSON = struct
// events.UsageRecorded do kit.

export const CURSOR_CONSUMER = "motor"

type EmitArgs = { tenantId: string; metric: string; count: number; period: string }

/** Append de UsageRecorded no outbox, na tx passada (outbox transacional). */
export async function emitUsageRecorded(tx: Tx, args: EmitArgs): Promise<void> {
  const payload = {
    tenant_id: args.tenantId,
    produto: PRODUTO,
    metric: args.metric,
    count: args.count,
    period: args.period,
  }
  // sql.json() envia como jsonb corretamente (um único encode) — passar
  // ${JSON.stringify(x)}::jsonb faz o postgres-js re-encodar (string scalar).
  await tx`
    INSERT INTO public.event_outbox (type, tenant_id, produto, payload)
    VALUES ('UsageRecorded', ${args.tenantId}::uuid, ${PRODUTO}, ${tx.json(payload)})
  `
}

export type OutboxEvent = {
  id: number
  type: string
  tenant_id: string
  produto: string | null
  payload: Record<string, unknown>
}

/** Lê o cursor do consumer do Motor (bus.event_cursors). */
export async function cursor(sql: Sql): Promise<number> {
  const rows = (await sql`
    SELECT last_id FROM bus.event_cursors WHERE consumer = ${CURSOR_CONSUMER}
  `) as unknown as { last_id: number }[]
  return rows[0]?.last_id ?? 0
}

/** Busca eventos do outbox após o cursor. */
export async function fetchAfter(sql: Sql, after: number, limit = 100): Promise<OutboxEvent[]> {
  return (await sql`
    SELECT id, type, tenant_id, produto, payload FROM public.event_outbox
    WHERE id > ${after} ORDER BY id LIMIT ${limit}
  `) as unknown as OutboxEvent[]
}

/** Avança o cursor (upsert em bus.event_cursors). */
export async function ack(sql: Sql, upTo: number): Promise<void> {
  await sql`
    INSERT INTO bus.event_cursors (consumer, last_id, updated_at)
    VALUES (${CURSOR_CONSUMER}, ${upTo}, now())
    ON CONFLICT (consumer) DO UPDATE SET last_id = EXCLUDED.last_id, updated_at = now()
  `
}
