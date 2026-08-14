import type { Tx, Json } from "@/lib/db"
import type { ContentStatus } from "@/lib/content/state-machine"

// Store tenant-scoped (queries sob withTenant; sem tenant_id, sem prefixo de schema —
// o search_path é a fronteira). SQL cru (postgres-js) para revisabilidade.

export type ContentItem = {
  id: string
  slug: string
  status: ContentStatus
  format: string
  pilar: string | null
  current_revision_id: string | null
  review_deadline_at: string | null
  scheduled_at: string | null
  published_at: string | null
  regen_count: number
  image_url: string | null
  publish_error: string | null
  /** true enquanto a IA escreve o rascunho em segundo plano (after()). */
  generating: boolean
  /** motivo da última falha de geração em background (o console mostra); null = ok. */
  generate_error: string | null
  // Motion (peça em movimento). is_motion marca a peça; render_* é o estado do
  // serviço de render; video_url é o MP4 pronto (R2).
  is_motion: boolean
  motion_preset: string | null
  motion_aspect: string | null
  video_url: string | null
  /** Fan-out: map aspecto→URL de todos os formatos renderizados desta peça. */
  video_urls: Record<string, string> | null
  render_status: string | null
  render_error: string | null
  // Clipe (corte de vídeo longo). is_clip marca a peça; reusa render_*/video_url.
  is_clip?: boolean
  clip_source_id?: string | null
  clip_aspect?: string | null
  /** versão do editor_config vigente na criação (proveniência p/ métricas). */
  config_version: number | null
  /** título da revisão atual (presente em listItems; ausente em getItem). */
  title?: string | null
}

/** Cria a peça JÁ marcada como generating (sem revisão ainda) e devolve o id —
 *  o rascunho é escrito depois, em segundo plano (after()). */
export async function createGeneratingItem(
  tx: Tx,
  input: { slug: string; format?: string; pilar?: string | null; authorId?: string | null },
): Promise<{ id: string }> {
  const [item] = (await tx`
    INSERT INTO content_items (slug, pilar, format, author_id, generating, config_version)
    VALUES (${input.slug}, ${input.pilar ?? null}, ${input.format ?? "blog"}, ${input.authorId ?? null}, true,
            (SELECT config_version FROM editor_config WHERE id = true))
    RETURNING id
  `) as unknown as { id: string }[]
  return item
}

/** Marca a peça como generating (regeneração em background) e limpa erro anterior. */
export async function markGenerating(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE content_items SET generating = true, generate_error = null, updated_at = now() WHERE id = ${id}`
}

/** Encerra a geração em background: generating=false + grava (ou limpa) o erro. */
export async function finishGenerating(tx: Tx, id: string, error: string | null): Promise<void> {
  await tx`UPDATE content_items SET generating = false, generate_error = ${error}, updated_at = now() WHERE id = ${id}`
}

// ── Motion (peça em movimento) ────────────────────────────────────────────────

/** Cria a peça de motion (is_motion, generating). Nasce em render_status='preparing'
 *  — NÃO em 'queued' — para o serviço de render NÃO pegá-la antes da geração gravar
 *  preset/aspect/props (race: a geração é assíncrona e agora chama a IA de verdade).
 *  Só vira 'queued' quando a geração termina (setRenderStatus). Sem revisão ainda. */
export async function createMotionItem(
  tx: Tx,
  input: { slug: string; format?: string; authorId?: string | null },
): Promise<{ id: string }> {
  const [item] = (await tx`
    INSERT INTO content_items (slug, format, author_id, is_motion, generating, render_status, config_version)
    VALUES (${input.slug}, ${input.format ?? "instagram"}, ${input.authorId ?? null}, true, true, 'preparing',
            (SELECT config_version FROM editor_config WHERE id = true))
    RETURNING id
  `) as unknown as { id: string }[]
  return item
}

/** Grava o preset escolhido pela geração e o aspecto da peça de motion. */
export async function setMotionMeta(
  tx: Tx,
  id: string,
  meta: { preset: string; aspect: string },
): Promise<void> {
  await tx`
    UPDATE content_items
       SET motion_preset = ${meta.preset}, motion_aspect = ${meta.aspect}, updated_at = now()
     WHERE id = ${id}
  `
}

/** Grava o MP4 do formato PRINCIPAL (R2) na peça — usado na publicação. */
export async function setItemVideo(tx: Tx, id: string, videoUrl: string): Promise<void> {
  await tx`UPDATE content_items SET video_url = ${videoUrl}, updated_at = now() WHERE id = ${id}`
}

/** Grava o map de TODOS os formatos renderizados (fan-out): aspecto→URL. */
export async function setItemVideos(tx: Tx, id: string, urls: Record<string, string>): Promise<void> {
  await tx`UPDATE content_items SET video_urls = ${tx.json(urls)}, updated_at = now() WHERE id = ${id}`
}

/** Estado do render (queued|rendering|done|error) + motivo do erro (null limpa). */
export async function setRenderStatus(
  tx: Tx,
  id: string,
  status: "queued" | "rendering" | "done" | "error",
  error: string | null = null,
): Promise<void> {
  await tx`
    UPDATE content_items
       SET render_status = ${status}, render_error = ${error}, updated_at = now()
     WHERE id = ${id}
  `
}

export type MotionProps = Record<string, unknown>

/** Peças de motion com render pendente (para a varredura do serviço de render). */
export async function listQueuedMotion(tx: Tx): Promise<
  { id: string; slug: string; motion_preset: string | null; motion_aspect: string | null }[]
> {
  return (await tx`
    SELECT id, slug, motion_preset, motion_aspect
      FROM content_items
     WHERE is_motion = true AND render_status = 'queued'
     ORDER BY created_at ASC
  `) as unknown as { id: string; slug: string; motion_preset: string | null; motion_aspect: string | null }[]
}

/** motion_props (campos do preset) da revisão atual de uma peça de motion. */
export async function getMotionProps(tx: Tx, itemId: string): Promise<MotionProps | null> {
  const rows = (await tx`
    SELECT cr.motion_props
      FROM content_items ci
      JOIN content_revisions cr ON cr.id = ci.current_revision_id
     WHERE ci.id = ${itemId}
  `) as unknown as { motion_props: MotionProps | null }[]
  return rows[0]?.motion_props ?? null
}

// ── Clipes Inteligentes ───────────────────────────────────────────────────────
// Uma fonte (clip_sources) percorre a esteira; cada clipe é um content_item is_clip
// que reusa render_status/video_url. O claim atômico (FOR UPDATE SKIP LOCKED) deixa
// o worker escalar em réplicas sem processar a mesma fonte/clipe em duplicidade.

export type ClipSource = {
  id: string
  kind: string
  origin: string
  content_hash: string | null
  r2_key_raw: string | null
  duration_seconds: number | null
  size_bytes: number | null
  status: string
  error: string | null
  transcript_id: string | null
  minutes_charged: number
  clips_count: number
  author_id: string | null
  created_at: string
  raw_expires_at: string | null
  expires_at: string | null
}

/** Cria a fonte de vídeo (job da esteira), nascendo em 'queued'. Idempotência por
 *  content_hash: se a mesma fonte já existe (dentro da retenção), devolve a existente
 *  em vez de reprocessar/recobrar. */
export async function createClipSource(
  tx: Tx,
  input: { kind: "upload" | "url"; origin: string; contentHash?: string | null; authorId?: string | null },
): Promise<ClipSource> {
  if (input.contentHash) {
    const existing = (await tx`
      SELECT * FROM clip_sources WHERE content_hash = ${input.contentHash}
    `) as unknown as ClipSource[]
    if (existing[0]) return existing[0]
  }
  const [row] = (await tx`
    INSERT INTO clip_sources (kind, origin, content_hash, author_id)
    VALUES (${input.kind}, ${input.origin}, ${input.contentHash ?? null}, ${input.authorId ?? null})
    RETURNING *
  `) as unknown as ClipSource[]
  return row
}

export async function getClipSource(tx: Tx, id: string): Promise<ClipSource | null> {
  const rows = (await tx`SELECT * FROM clip_sources WHERE id = ${id}`) as unknown as ClipSource[]
  return rows[0] ?? null
}

/** Fontes do tenant, mais recentes primeiro (para a fila/lista do console). */
export async function listClipSources(tx: Tx, limit = 50): Promise<ClipSource[]> {
  return (await tx`
    SELECT * FROM clip_sources ORDER BY created_at DESC LIMIT ${limit}
  `) as unknown as ClipSource[]
}

export type ClipItemView = {
  id: string
  slug: string
  title: string | null
  status: string
  render_status: string | null
  clip_aspect: string | null
  video_url: string | null
  score: number | null
  in_ms: number | null
  out_ms: number | null
  brand_on: boolean | null
}

/** Clipes gerados a partir de uma fonte (para o detalhe/grade do console). Traz os
 *  campos do corte para pré-preencher o editor-lite. */
export async function listClipsForSource(tx: Tx, sourceId: string): Promise<ClipItemView[]> {
  return (await tx`
    SELECT ci.id, ci.slug, cr.title, ci.status, ci.render_status, ci.clip_aspect, ci.video_url,
           (cr.clip_props->>'score')::int AS score,
           (cr.clip_props->>'inMs')::int  AS in_ms,
           (cr.clip_props->>'outMs')::int AS out_ms,
           (cr.clip_props->>'brandOn')::boolean AS brand_on
      FROM content_items ci
      LEFT JOIN content_revisions cr ON cr.id = ci.current_revision_id
     WHERE ci.is_clip = true AND ci.clip_source_id = ${sourceId}
     ORDER BY ci.created_at ASC
  `) as unknown as ClipItemView[]
}

/** Reivindica atomicamente a próxima fonte num dos estágios `from`, movendo-a para
 *  `to` e marcando o lease (claimed_at). Devolve null se não houver nenhuma livre.
 *  FOR UPDATE SKIP LOCKED = duas réplicas nunca pegam a mesma fonte. */
export async function claimClipSource(
  tx: Tx,
  from: string[],
  to: string,
): Promise<ClipSource | null> {
  const rows = (await tx`
    UPDATE clip_sources SET status = ${to}, claimed_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM clip_sources
        WHERE status = ANY(${from})
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING *
  `) as unknown as ClipSource[]
  return rows[0] ?? null
}

/** Avança o estágio de uma fonte (sem claim — dentro do processamento já reivindicado). */
export async function setClipSourceStatus(tx: Tx, id: string, status: string): Promise<void> {
  await tx`UPDATE clip_sources SET status = ${status}, updated_at = now() WHERE id = ${id}`
}

/** Devolve à fila fontes presas num estágio intermediário há mais de `staleSeconds`
 *  (o worker caiu no meio). Reprocessar é idempotente (horas não recobram). Devolve
 *  quantas foram recolocadas. */
export async function requeueStaleClipSources(tx: Tx, staleSeconds: number): Promise<number> {
  const rows = (await tx`
    UPDATE clip_sources SET status = 'queued', claimed_at = NULL, updated_at = now()
     WHERE status NOT IN ('queued', 'done', 'error')
       AND updated_at < now() - (${staleSeconds} * interval '1 second')
    RETURNING id
  `) as unknown as { id: string }[]
  return rows.length
}

/** Marca a fonte com erro (a esteira retoma/estorna a partir daqui). */
export async function setClipSourceError(tx: Tx, id: string, error: string): Promise<void> {
  await tx`UPDATE clip_sources SET status = 'error', error = ${error}, updated_at = now() WHERE id = ${id}`
}

/** Grava os metadados do probe + horas debitadas + janelas de expiração (bruto/JSON). */
export async function setClipSourceProbe(
  tx: Tx,
  id: string,
  probe: {
    durationSeconds: number
    sizeBytes: number
    minutesCharged: number
    rawKey: string
    rawExpiresAt: string
    expiresAt: string
  },
): Promise<void> {
  await tx`
    UPDATE clip_sources
       SET duration_seconds = ${probe.durationSeconds},
           size_bytes = ${probe.sizeBytes},
           minutes_charged = ${probe.minutesCharged},
           r2_key_raw = ${probe.rawKey},
           raw_expires_at = ${probe.rawExpiresAt},
           expires_at = ${probe.expiresAt},
           updated_at = now()
     WHERE id = ${id}
  `
}

export async function setClipSourceClips(tx: Tx, id: string, count: number): Promise<void> {
  await tx`UPDATE clip_sources SET clips_count = ${count}, updated_at = now() WHERE id = ${id}`
}

/** Persiste a transcrição (texto + palavras com tempo) e a liga à fonte. */
export async function saveTranscript(
  tx: Tx,
  input: { sourceId: string; lang: string | null; text: string; words: unknown[]; expiresAt: string },
): Promise<string> {
  const [row] = (await tx`
    INSERT INTO clip_transcripts (source_id, lang, text, words, expires_at)
    VALUES (${input.sourceId}, ${input.lang}, ${input.text}, ${tx.json(input.words as Json)}, ${input.expiresAt})
    RETURNING id
  `) as unknown as { id: string }[]
  await tx`UPDATE clip_sources SET transcript_id = ${row.id}, updated_at = now() WHERE id = ${input.sourceId}`
  return row.id
}

export type Transcript = { id: string; text: string; words: unknown[]; lang: string | null }

export async function getTranscript(tx: Tx, sourceId: string): Promise<Transcript | null> {
  const rows = (await tx`
    SELECT id, text, words, lang FROM clip_transcripts WHERE source_id = ${sourceId} ORDER BY created_at DESC LIMIT 1
  `) as unknown as Transcript[]
  return rows[0] ?? null
}

/** Reescreve as palavras da transcrição (correção de termo propagada por vídeo). */
export async function updateTranscriptWords(tx: Tx, sourceId: string, words: unknown[]): Promise<void> {
  await tx`UPDATE clip_transcripts SET words = ${tx.json(words as Json)} WHERE source_id = ${sourceId}`
}

/** Cria o clipe como content_item (is_clip), nascendo em render_status='preparing'
 *  — igual ao motion, para o render NÃO pegá-lo antes das clip_props gravadas. */
export async function createClipItem(
  tx: Tx,
  input: { slug: string; aspect: string; sourceId: string; format?: string; authorId?: string | null },
): Promise<{ id: string }> {
  const [item] = (await tx`
    INSERT INTO content_items (slug, format, author_id, is_clip, clip_source_id, clip_aspect, generating, render_status, config_version)
    VALUES (${input.slug}, ${input.format ?? "instagram"}, ${input.authorId ?? null}, true, ${input.sourceId}, ${input.aspect}, true, 'preparing',
            (SELECT config_version FROM editor_config WHERE id = true))
    RETURNING id
  `) as unknown as { id: string }[]
  return item
}

/** Clipes com render pendente (varredura do clip-worker — is_clip, não colide com motion). */
export async function listQueuedClips(tx: Tx): Promise<{ id: string; slug: string; clip_aspect: string | null }[]> {
  return (await tx`
    SELECT id, slug, clip_aspect
      FROM content_items
     WHERE is_clip = true AND render_status = 'queued'
     ORDER BY created_at ASC
  `) as unknown as { id: string; slug: string; clip_aspect: string | null }[]
}

// ── Retenção / expiração (SPEC §3.8) ──────────────────────────────────────────

/** Fontes cujo vídeo-fonte BRUTO já venceu (7d) e ainda têm bruto no R2. */
export async function listExpiredClipRaw(tx: Tx): Promise<{ id: string; r2_key_raw: string }[]> {
  return (await tx`
    SELECT id, r2_key_raw FROM clip_sources
     WHERE r2_key_raw IS NOT NULL AND raw_expires_at IS NOT NULL AND raw_expires_at <= now()
  `) as unknown as { id: string; r2_key_raw: string }[]
}

/** Limpa a referência ao bruto após removê-lo do R2. */
export async function clearClipRaw(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE clip_sources SET r2_key_raw = NULL, updated_at = now() WHERE id = ${id}`
}

/** Fontes totalmente vencidas (60d) — a remover com transcrição e clipes. */
export async function listExpiredClipSourceIds(tx: Tx): Promise<string[]> {
  const rows = (await tx`
    SELECT id FROM clip_sources WHERE expires_at IS NOT NULL AND expires_at <= now()
  `) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

/** Remove a fonte (transcrição cai por cascade). Os clipes (content_items) são
 *  removidos à parte pelo chamador (deleteItem + storage). */
export async function deleteClipSource(tx: Tx, id: string): Promise<void> {
  await tx`DELETE FROM clip_sources WHERE id = ${id}`
}

/** Fontes cujos clipes serão removidos em ~3 dias e que ainda não foram avisadas. */
export async function listClipSourcesToWarn(tx: Tx, daysAhead: number): Promise<{ id: string }[]> {
  return (await tx`
    SELECT id FROM clip_sources
     WHERE warned_at IS NULL AND clips_count > 0 AND expires_at IS NOT NULL
       AND expires_at <= now() + (${daysAhead} * interval '1 day')
       AND expires_at > now()
  `) as unknown as { id: string }[]
}

export async function markClipSourceWarned(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE clip_sources SET warned_at = now() WHERE id = ${id}`
}

/** clip_props (janela/legenda/card) da revisão atual do clipe. */
export async function getClipProps(tx: Tx, itemId: string): Promise<Record<string, unknown> | null> {
  const rows = (await tx`
    SELECT cr.clip_props
      FROM content_items ci
      JOIN content_revisions cr ON cr.id = ci.current_revision_id
     WHERE ci.id = ${itemId}
  `) as unknown as { clip_props: Record<string, unknown> | null }[]
  return rows[0]?.clip_props ?? null
}

export type ClipEditContext = {
  clip_source_id: string | null
  status: string
  clip_props: Record<string, unknown> | null
}

/** Contexto para editar um clipe: a fonte (p/ re-recortar as palavras), o estado
 *  (só edita antes de publicar) e as props atuais. null se não é clipe. */
export async function getClipEditContext(tx: Tx, itemId: string): Promise<ClipEditContext | null> {
  const rows = (await tx`
    SELECT ci.clip_source_id, ci.status, cr.clip_props
      FROM content_items ci
      LEFT JOIN content_revisions cr ON cr.id = ci.current_revision_id
     WHERE ci.id = ${itemId} AND ci.is_clip = true
  `) as unknown as ClipEditContext[]
  return rows[0] ?? null
}

/** Atualiza as clip_props da revisão atual no lugar (o editor-lite reajusta o corte
 *  e re-renderiza; não versiona como peça editorial). */
export async function updateClipPropsInPlace(tx: Tx, itemId: string, props: Record<string, unknown>): Promise<void> {
  await tx`
    UPDATE content_revisions SET clip_props = ${tx.json(props as Json)}
     WHERE id = (SELECT current_revision_id FROM content_items WHERE id = ${itemId})
  `
}

/** Registra (ou limpa, com null) o erro da última tentativa de publicação em
 *  segundo plano — o console mostra na peça. */
export async function setPublishError(tx: Tx, id: string, error: string | null): Promise<void> {
  await tx`UPDATE content_items SET publish_error = ${error} WHERE id = ${id}`
}

/** Grava a imagem on-brand escolhida da peça (gerada ou trocada pela biblioteca). */
export async function setItemImage(tx: Tx, id: string, imageUrl: string): Promise<void> {
  await tx`UPDATE content_items SET image_url = ${imageUrl}, updated_at = now() WHERE id = ${id}`
}

/** Exclui a peça (revisões/social_drafts/análises caem por ON DELETE CASCADE).
 *  Devolve a image_url que estava salva, para o caller limpar o storage. */
export async function deleteItem(tx: Tx, id: string): Promise<{ image_url: string | null } | null> {
  const rows = (await tx`
    DELETE FROM content_items WHERE id = ${id} RETURNING image_url
  `) as unknown as { image_url: string | null }[]
  return rows[0] ?? null
}

export type NewItem = {
  slug: string
  title: string
  bodyMarkdown: string
  excerpt?: string
  format?: string
  pilar?: string | null
  authorId?: string | null
  /** SEO (ex.: { keywords: string[] }) — persistido no jsonb da revisão. */
  seo?: Record<string, unknown>
}

/** Cria uma peça em draft + 1ª revisão, apontando current_revision_id. */
export async function createItem(tx: Tx, input: NewItem): Promise<ContentItem> {
  const [item] = (await tx`
    INSERT INTO content_items (slug, pilar, format, author_id, config_version)
    VALUES (${input.slug}, ${input.pilar ?? null}, ${input.format ?? "blog"}, ${input.authorId ?? null},
            (SELECT config_version FROM editor_config WHERE id = true))
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

/** Rascunhos sociais ativos (draft|approved), 1 por plataforma (o mais recente). */
export async function listSocialDrafts(tx: Tx, itemId: string): Promise<SocialDraft[]> {
  return (await tx`
    SELECT DISTINCT ON (platform) platform, body, hashtags, status FROM social_drafts
     WHERE content_item_id = ${itemId} AND status IN ('draft','approved')
     ORDER BY platform, created_at DESC
  `) as unknown as SocialDraft[]
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
  input: {
    title: string
    bodyMarkdown: string
    excerpt?: string
    ai: boolean
    authorId?: string | null
    /** SEO (ex.: { keywords: string[] }) — persistido no jsonb da revisão. */
    seo?: Record<string, unknown>
    /** Campos do preset de motion (words/quote/slides/stat+source) — coluna dedicada. */
    motionProps?: Record<string, unknown>
    /** Props do clipe (janela de corte, legenda, card de abertura) — coluna dedicada. */
    clipProps?: Record<string, unknown>
  },
): Promise<string> {
  const [rev] = (await tx`
    INSERT INTO content_revisions (content_item_id, title, body_markdown, excerpt, seo, motion_props, clip_props, ai_generated, author_id)
    VALUES (${itemId}, ${input.title}, ${input.bodyMarkdown}, ${input.excerpt ?? null}, ${tx.json((input.seo ?? {}) as Json)}, ${input.motionProps ? tx.json(input.motionProps as Json) : null}, ${input.clipProps ? tx.json(input.clipProps as Json) : null}, ${input.ai}, ${input.authorId ?? null})
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

export type ProposedFrom = { type?: string; recommendation: string }

export type ProposedRevision = {
  id: string
  title: string
  body_markdown: string
  excerpt: string | null
  proposed_from: ProposedFrom | null
  created_at: string
}

// Insere uma revisão PROPOSTA pela IA: não vira a revisão atual (is_proposed=true).
export async function insertProposedRevision(
  tx: Tx,
  itemId: string,
  input: { title: string; bodyMarkdown: string; excerpt?: string },
  proposedFrom: ProposedFrom,
): Promise<string> {
  const [rev] = (await tx`
    INSERT INTO content_revisions
      (content_item_id, title, body_markdown, excerpt, ai_generated, is_proposed, proposed_from)
    VALUES (${itemId}, ${input.title}, ${input.bodyMarkdown}, ${input.excerpt ?? null}, true, true, ${tx.json(proposedFrom)})
    RETURNING id
  `) as unknown as { id: string }[]
  return rev.id
}

export async function listProposedRevisions(tx: Tx, itemId: string): Promise<ProposedRevision[]> {
  return (await tx`
    SELECT id, title, body_markdown, excerpt, proposed_from, created_at
      FROM content_revisions
     WHERE content_item_id = ${itemId} AND is_proposed = true
     ORDER BY created_at DESC
  `) as unknown as ProposedRevision[]
}

// Aceitar: a proposta deixa de ser proposta e passa a ser a revisão atual da peça.
export async function acceptProposal(tx: Tx, itemId: string, proposalId: string): Promise<boolean> {
  const rows = (await tx`
    UPDATE content_revisions SET is_proposed = false
     WHERE id = ${proposalId} AND content_item_id = ${itemId} AND is_proposed = true
     RETURNING id
  `) as unknown as { id: string }[]
  if (rows.length === 0) return false
  await tx`UPDATE content_items SET current_revision_id = ${proposalId}, updated_at = now() WHERE id = ${itemId}`
  return true
}

export async function discardProposal(tx: Tx, itemId: string, proposalId: string): Promise<boolean> {
  const rows = (await tx`
    DELETE FROM content_revisions
     WHERE id = ${proposalId} AND content_item_id = ${itemId} AND is_proposed = true
     RETURNING id
  `) as unknown as { id: string }[]
  return rows.length > 0
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
  return (await tx`
    SELECT ci.*, cr.title FROM content_items ci
      LEFT JOIN content_revisions cr ON cr.id = ci.current_revision_id
     ORDER BY ci.updated_at DESC LIMIT ${limit}
  `) as unknown as ContentItem[]
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
