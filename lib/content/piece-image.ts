import type { Sql } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { getItem, getItemWithRevision, setItemImage } from "./store"
import { getEditorConfig } from "./editor-config"
import { generateAndStoreCover, isImageConfigured } from "@/lib/brand/social-image"
import type { FormatId } from "@/lib/brand/formats"

// Formato on-brand por canal da peça (blog→OG, linkedin→feed 1:1, instagram→4:5).
const COVER_FORMAT: Record<string, FormatId> = {
  blog: "blog-og",
  linkedin: "li-feed",
  instagram: "ig-feed",
}

/**
 * Gera a imagem on-brand da peça no formato do canal e a persiste
 * (content_items.image_url). Devolve a URL, ou null.
 *
 * **Best-effort**: sem storage configurado (seam) devolve null sem lançar — a
 * peça é criada mesmo assim. A imagem nasce JUNTO com a descrição (chamada no
 * create/regenerate), e o publish a reaproveita.
 */
export async function generatePieceImage(sql: Sql, tenantId: string, id: string): Promise<string | null> {
  if (!isImageConfigured()) return null
  const info = await withTenant(sql, tenantId, async (tx) => {
    const item = await getItem(tx, id)
    const rev = await getItemWithRevision(tx, id)
    const cfg = await getEditorConfig(tx)
    return item && rev
      ? { slug: item.slug, pilar: item.pilar, format: item.format, title: rev.title, handle: cfg.handle }
      : null
  })
  if (!info) return null
  const formatId = COVER_FORMAT[info.format] ?? "ig-feed"
  // Rodapé de marca = handle do cliente (vazio → sem rodapé; nunca "SAPIENZA LABS").
  const footer = info.handle.trim() ? info.handle.trim().toUpperCase() : undefined
  const url = await generateAndStoreCover(tenantId, {
    slug: info.slug,
    title: info.title,
    pilar: info.pilar,
    formatId,
    footer,
  })
  if (url) await withTenant(sql, tenantId, (tx) => setItemImage(tx, id, url))
  return url
}
