import type { Tx } from "@/lib/db"
import type { ContentStatus } from "@/lib/content/state-machine"

// Store tenant-scoped (queries sob withTenant; sem tenant_id, sem prefixo de schema —
// o search_path é a fronteira). SQL cru (postgres-js) para revisabilidade.

export type ContentItem = {
  id: string
  slug: string
  status: ContentStatus
  pilar: string | null
  current_revision_id: string | null
  review_deadline_at: string | null
  scheduled_at: string | null
  published_at: string | null
  regen_count: number
}

export type NewItem = {
  slug: string
  title: string
  bodyMarkdown: string
  excerpt?: string
  pilar?: string | null
  authorId?: string | null
}

/** Cria uma peça em draft + 1ª revisão, apontando current_revision_id. */
export async function createItem(tx: Tx, input: NewItem): Promise<ContentItem> {
  const [item] = (await tx`
    INSERT INTO content_items (slug, pilar, author_id)
    VALUES (${input.slug}, ${input.pilar ?? null}, ${input.authorId ?? null})
    RETURNING *
  `) as unknown as ContentItem[]
  const [rev] = (await tx`
    INSERT INTO content_revisions (content_item_id, title, body_markdown, excerpt, ai_generated, author_id)
    VALUES (${item.id}, ${input.title}, ${input.bodyMarkdown}, ${input.excerpt ?? null}, false, ${input.authorId ?? null})
    RETURNING id
  `) as unknown as { id: string }[]
  await tx`UPDATE content_items SET current_revision_id = ${rev.id}, updated_at = now() WHERE id = ${item.id}`
  item.current_revision_id = rev.id
  return item
}

export async function getItem(tx: Tx, id: string): Promise<ContentItem | null> {
  const rows = (await tx`SELECT * FROM content_items WHERE id = ${id}`) as unknown as ContentItem[]
  return rows[0] ?? null
}

/** Adiciona uma revisão (gerada por IA = regeneração); atualiza current_revision_id
 *  e, quando ai=true, incrementa regen_count. */
export async function addRevision(
  tx: Tx,
  itemId: string,
  input: { title: string; bodyMarkdown: string; excerpt?: string; ai: boolean; authorId?: string | null },
): Promise<string> {
  const [rev] = (await tx`
    INSERT INTO content_revisions (content_item_id, title, body_markdown, excerpt, ai_generated, author_id)
    VALUES (${itemId}, ${input.title}, ${input.bodyMarkdown}, ${input.excerpt ?? null}, ${input.ai}, ${input.authorId ?? null})
    RETURNING id
  `) as unknown as { id: string }[]
  await tx`
    UPDATE content_items
       SET current_revision_id = ${rev.id},
           regen_count = regen_count + ${input.ai ? 1 : 0},
           updated_at = now()
     WHERE id = ${itemId}
  `
  return rev.id
}

export async function insertAudit(
  tx: Tx,
  a: { itemId: string; actorId?: string | null; from: string | null; to: string; note?: string | null },
): Promise<void> {
  await tx`
    INSERT INTO audit_log (content_item_id, actor_id, from_status, to_status, note)
    VALUES (${a.itemId}, ${a.actorId ?? null}, ${a.from}, ${a.to}, ${a.note ?? null})
  `
}

/** Peças 'scheduled' com scheduled_at vencido. */
export async function listDueScheduled(tx: Tx): Promise<ContentItem[]> {
  return (await tx`
    SELECT * FROM content_items WHERE status = 'scheduled' AND scheduled_at <= now()
  `) as unknown as ContentItem[]
}

/** Peças 'in_review' cuja janela de aprovação venceu (silêncio = aprovado). */
export async function listExpiredReview(tx: Tx): Promise<ContentItem[]> {
  return (await tx`
    SELECT * FROM content_items WHERE status = 'in_review' AND review_deadline_at <= now()
  `) as unknown as ContentItem[]
}

export async function listItems(tx: Tx, limit = 100): Promise<ContentItem[]> {
  return (await tx`SELECT * FROM content_items ORDER BY updated_at DESC LIMIT ${limit}`) as unknown as ContentItem[]
}
