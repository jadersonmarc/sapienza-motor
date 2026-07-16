// Fonte única das chaves do R2, organizadas por finalidade (pastas). Puro: sem
// dependência de SDK/env — só monta strings. Ninguém deve montar caminho de R2 à
// mão; tudo passa por aqui. Convenção forward: chaves antigas continuam válidas.
import type { FormatId } from "@/lib/brand/formats"

export type R2Purpose = "article" | "instagram" | "linkedin" | "editor" | "page" | "geral"

// Prefixo (pasta) por finalidade. `social/<plataforma>` agrupa as imagens sociais;
// `geral` é a pasta-curinga da biblioteca para o que não se encaixa nas demais.
const PREFIX: Record<R2Purpose, string> = {
  article: "articles",
  instagram: "social/instagram",
  linkedin: "social/linkedin",
  editor: "editor",
  page: "pages",
  geral: "geral",
}

/** Todas as finalidades navegáveis na biblioteca de mídia (ordem de exibição). */
export const R2_PURPOSES: readonly R2Purpose[] = [
  "instagram",
  "linkedin",
  "article",
  "page",
  "editor",
  "geral",
]

export function isR2Purpose(v: string): v is R2Purpose {
  return (R2_PURPOSES as readonly string[]).includes(v)
}

/** Prefixo da pasta de uma finalidade (sem barra final). Alimenta o list-by-prefix. */
export function prefixFor(purpose: R2Purpose): string {
  return PREFIX[purpose]
}

/** Prefixo com barra final, para listar uma pasta inteira (picker). */
export function listPrefixFor(purpose: R2Purpose): string {
  return `${PREFIX[purpose]}/`
}

export type BrandImagePurpose = Extract<R2Purpose, "article" | "instagram" | "linkedin">

/**
 * Chave de imagem de marca (capa/OG do artigo ou card social) por finalidade.
 * - article:  `articles/<slug>/<formatId>.<ext>`
 * - social:   `social/<plataforma>/<slug>__<formatId>.<ext>`
 */
export function brandImageKey(opts: {
  purpose: BrandImagePurpose
  slug: string
  formatId: FormatId
  ext?: string
}): string {
  const ext = opts.ext ?? "png"
  if (opts.purpose === "article") {
    return `${PREFIX.article}/${opts.slug}/${opts.formatId}.${ext}`
  }
  return `${PREFIX[opts.purpose]}/${opts.slug}__${opts.formatId}.${ext}`
}

/** Chave de upload genérico da biblioteca para uma finalidade: `<pasta>/<uuid>.<ext>`. */
export function mediaUploadKey(opts: { purpose: R2Purpose; uuid: string; ext: string }): string {
  return `${PREFIX[opts.purpose]}/${opts.uuid}.${opts.ext}`
}

/** Chave de imagem social enviada/trocada pelo operador: `social/<plataforma>/<uuid>.<ext>`. */
export function socialUploadKey(opts: {
  platform: Extract<R2Purpose, "instagram" | "linkedin">
  uuid: string
  ext: string
}): string {
  return mediaUploadKey({ purpose: opts.platform, uuid: opts.uuid, ext: opts.ext })
}

/** Chave de upload do editor de markdown: `editor/<aaaa>/<mm>/<uuid>.<ext>`. */
export function editorUploadKey(opts: { uuid: string; ext: string; date?: Date }): string {
  const d = opts.date ?? new Date()
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${PREFIX.editor}/${yyyy}/${mm}/${opts.uuid}.${opts.ext}`
}
