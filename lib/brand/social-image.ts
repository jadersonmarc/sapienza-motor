import { composeBrandImage, r2KeyFor, type ArchetypeId } from "./compose"
import { renderBrandImage } from "./render"
import type { FormatId } from "./formats"
import type { Pilar } from "./pillar"
import { uploadObject, isStorageConfigured } from "@/lib/storage/s3"

// Cola entre o renderer de marca (Satori/next-og) e o storage (R2): compõe o
// arquétipo, renderiza o PNG on-brand e sobe no R2, devolvendo a URL pública que
// o publish anexa (obrigatória p/ Instagram). Storage é um seam: sem env S3_*
// configurado, retorna null e a publicação segue sem imagem.

export type SocialImageInput = {
  slug: string
  title: string
  pilar?: Pilar
  archetype?: ArchetypeId
  formatId?: FormatId
}

export function isImageConfigured(): boolean {
  return isStorageConfigured()
}

/** Renderiza a imagem on-brand da peça (PNG). Determinístico. */
export async function renderSocialImage(
  input: SocialImageInput,
): Promise<{ buffer: Buffer; formatId: FormatId }> {
  const formatId = input.formatId ?? "ig-feed"
  const { format, node } = composeBrandImage({
    archetype: input.archetype ?? "capa",
    formatId,
    pilar: input.pilar ?? null,
    text: input.title,
  })
  const res = renderBrandImage(format, node)
  const buffer = Buffer.from(await res.arrayBuffer())
  return { buffer, formatId }
}

/** Gera a imagem e sobe no R2; retorna a URL pública, ou null se o storage não
 *  estiver configurado (seam — publica sem imagem). */
export async function generateAndStoreCover(input: SocialImageInput): Promise<string | null> {
  if (!isStorageConfigured()) return null
  const { buffer, formatId } = await renderSocialImage(input)
  const key = r2KeyFor({ slug: input.slug, formatId })
  return uploadObject(key, buffer, "image/png")
}
