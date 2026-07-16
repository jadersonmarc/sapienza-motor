import { composeBrandImage, type ArchetypeId } from "@/lib/brand/compose"
import { formats, type FormatId } from "@/lib/brand/formats"
import { renderBrandImage } from "@/lib/brand/render"
import type { Field } from "@/lib/brand/tokens"
import { isPublicAssetUrl } from "@/lib/storage/s3"

// Render on-demand de uma peça da marca (preview do composer no console). Não
// toca dados de tenant — só rende a partir dos params de texto, então é público e
// cacheado pela URL completa. Adaptado do spa-sapienza/app/api/og.
//
// Por ser pública e renderizada no servidor, `?image=` é restrito ao nosso bucket
// (isPublicAssetUrl): é a única entrada que faria o servidor buscar uma URL de
// terceiro — sem a allowlist, a rota vira um SSRF com resposta cacheada.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ARCHETYPES = new Set<ArchetypeId>(["capa", "conceito", "diagrama", "carrossel", "bastidores"])

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams
  const archetype = (p.get("archetype") ?? "capa") as ArchetypeId
  const formatId = (p.get("format") ?? "ig-feed") as FormatId

  if (!ARCHETYPES.has(archetype) || !(formatId in formats)) {
    return new Response("parâmetro inválido", { status: 400 })
  }

  const fieldParam = p.get("field")
  const field = fieldParam === "ink" || fieldParam === "surface" ? (fieldParam as Field) : undefined

  // Fora do bucket público → ignora (rende sem imagem) em vez de buscar.
  const imageParam = p.get("image")
  const imageUrl = imageParam && isPublicAssetUrl(imageParam) ? imageParam : undefined

  const { format, node } = composeBrandImage({
    archetype,
    formatId,
    pilar: p.get("pilar"), // texto livre no Motor (ver pillar.ts)
    field,
    text: (p.get("text") ?? "Sapienza Labs").slice(0, 200),
    index: Number(p.get("index")) || undefined,
    total: Number(p.get("total")) || undefined,
    kind: (p.get("kind") as "cover" | "body" | "cta") || undefined,
    imageUrl,
    caption: p.get("caption")?.slice(0, 200) ?? undefined,
  })

  // Cache pela URL completa (texto/pilar/aspecto entram na chave).
  return renderBrandImage(format, node, {
    headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800" },
  })
}
