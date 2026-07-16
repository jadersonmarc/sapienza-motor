import type { Tx, Json } from "@/lib/db"
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
  /** SEO (ex.: { keywords: string[] }) — persistido no jsonb da revisão. */
  seo?: Record<string, unknown>
}

/** Cria uma peça em draft + 1ª revisão, apontando current_revision_id. */
export async function createItem(tx: Tx, input: NewItem): Promise<ContentItem> {
  const [item] = (await tx`
    INSERT INTO content_items (slug, pilar, author_id)
    VALUES (${input.slug}, ${input.pilar ?? null}, ${input.authorId ?? null})
    RETURNING *
  `) as unknown as ContentItem[]
  // jsonb via tx.json (nunca JSON.stringify::jsonb — re-encoda e quebra o payload).
  const [rev] = (await tx`
    INSERT INTO content_revisions (content_item_id, title, body_markdown, excerpt, seo, ai_generated, author_id)
    VALUES (${item.id}, ${input.title}, ${input.bodyMarkdown}, ${input.excerpt ?? null}, ${tx.json((input.seo ?? {}) as Json)}, false, ${input.authorId ?? null})
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

export type CurrentRevision = {
  id: string
  title: string
  body_markdown: string
  excerpt: string | null
  seo: Record<string, unknown>
  pilar: string | null
  slug: string
}

/** Peça + sua revisão atual (título/corpo/excerpt/seo) — base dos geradores. */
export async function getItemWithRevision(tx: Tx, itemId: string): Promise<CurrentRevision | null> {
  const rows = (await tx`
    SELECT cr.id, cr.title, cr.body_markdown, cr.excerpt, cr.seo, ci.pilar, ci.slug
      FROM content_items ci
      JOIN content_revisions cr ON cr.id = ci.current_revision_id
     WHERE ci.id = ${itemId}
  `) as unknown as CurrentRevision[]
  return rows[0] ?? null
}

/** Cria/atualiza o rascunho social (status draft) de uma plataforma — um por
 *  plataforma (remove os drafts anteriores da mesma plataforma). */
export async function upsertSocialDraft(
  tx: Tx,
  input: { itemId: string; revisionId?: string | null; platform: string; body: string; hashtags: string[] },
): Promise<string> {
  await tx`
    DELETE FROM social_drafts
     WHERE content_item_id = ${input.itemId} AND platform = ${input.platform} AND status = 'draft'
  `
  const [row] = (await tx`
    INSERT INTO social_drafts (content_item_id, revision_id, platform, body, hashtags, status)
    VALUES (${input.itemId}, ${input.revisionId ?? null}, ${input.platform}, ${input.body}, ${tx.json(input.hashtags)}, 'draft')
    RETURNING id
  `) as unknown as { id: string }[]
  return row.id
}

export type SocialDraft = { platform: string; body: string; hashtags: string[]; status: string }

/** Rascunho social mais recente ainda não enviado (draft|approved) de uma plataforma. */
export async function socialDraftFor(tx: Tx, itemId: string, platform: string): Promise<SocialDraft | null> {
  const rows = (await tx`
    SELECT platform, body, hashtags, status FROM social_drafts
     WHERE content_item_id = ${itemId} AND platform = ${platform} AND status IN ('draft','approved')
     ORDER BY created_at DESC LIMIT 1
  `) as unknown as SocialDraft[]
  return rows[0] ?? null
}

export async function insertAnalysis(
  tx: Tx,
  input: { itemId: string; revisionId?: string | null; type: string; payload: unknown; model?: string | null },
): Promise<string> {
  const [row] = (await tx`
    INSERT INTO ai_analyses (content_item_id, revision_id, type, payload, model)
    VALUES (${input.itemId}, ${input.revisionId ?? null}, ${input.type}, ${tx.json((input.payload ?? {}) as Json)}, ${input.model ?? null})
    RETURNING id
  `) as unknown as { id: string }[]
  return row.id
}

export type Analysis = { type: string; payload: unknown; model: string | null; created_at: string }

export async function listAnalyses(tx: Tx, itemId: string): Promise<Analysis[]> {
  return (await tx`
    SELECT type, payload, model, created_at FROM ai_analyses
     WHERE content_item_id = ${itemId} ORDER BY created_at DESC
  `) as unknown as Analysis[]
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

/** Títulos das revisões atuais (para o cron evitar repetir temas). */
export async function listItemTitles(tx: Tx, limit = 40): Promise<string[]> {
  const rows = (await tx`
    SELECT cr.title FROM content_items ci
      JOIN content_revisions cr ON cr.id = ci.current_revision_id
     ORDER BY ci.created_at DESC LIMIT ${limit}
  `) as unknown as { title: string }[]
  return rows.map((r) => r.title)
}
