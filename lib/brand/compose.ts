import type { ReactElement } from "react"
import { getFormat, type Format, type FormatId } from "./formats"
import { brandImageKey } from "@/lib/storage/keys"
import { pillarStyle, type Pilar } from "./pillar"
import type { Field } from "./tokens"
import { CapaEditorial } from "./templates/capa-editorial"
import { CardConceito } from "./templates/card-conceito"
import { Diagrama, type DiagramaNode } from "./templates/diagrama"
import { CarrosselSlide } from "./templates/carrossel-slide"
import { Bastidores } from "./templates/bastidores"

export type ArchetypeId = "capa" | "conceito" | "diagrama" | "carrossel" | "bastidores"

export interface ComposeInput {
  archetype: ArchetypeId
  formatId: FormatId
  pilar: Pilar
  /** título / frase / texto principal */
  text: string
  /** sobrescreve o campo padrão do pilar */
  field?: Field
  footer?: string
  // carrossel
  index?: number
  total?: number
  kind?: "cover" | "body" | "cta"
  // diagrama
  nodes?: DiagramaNode[]
  // bastidores
  imageUrl?: string
  caption?: string
}

// Ponto único que mapeia entrada estruturada → arquétipo. Usado pela rota de
// render on-demand (preview) e pela geração de imagem social. Adaptado do
// spa-sapienza: pilar é texto livre (ver pillar.ts), sem enum do blog.
export function composeBrandImage(input: ComposeInput): { format: Format; node: ReactElement } {
  const format = getFormat(input.formatId)
  const { tag, field: pilarField } = pillarStyle(input.pilar)
  const field = input.field ?? pilarField
  const footer = input.footer ?? "SAPIENZA LABS"

  switch (input.archetype) {
    case "conceito":
      return { format, node: CardConceito({ format, field, eyebrow: tag, phrase: input.text, footer }) }
    case "diagrama":
      return { format, node: Diagrama({ format, field, eyebrow: tag, nodes: input.nodes ?? [], footer }) }
    case "carrossel":
      return {
        format,
        node: CarrosselSlide({
          format,
          field,
          eyebrow: "SÉRIE",
          index: input.index ?? 1,
          total: input.total ?? 1,
          kind: input.kind ?? "cover",
          text: input.text,
        }),
      }
    case "bastidores":
      return { format, node: Bastidores({ format, imageUrl: input.imageUrl ?? "", caption: input.caption ?? input.text }) }
    case "capa":
    default:
      return { format, node: CapaEditorial({ format, field, eyebrow: tag, title: input.text, footer }) }
  }
}

/**
 * Chave R2 da imagem de marca, delegando ao file-system por finalidade
 * (`lib/storage/keys.ts`). O canal do formato define a pasta:
 * `blog` → artigo, `ig` → instagram, `li` → linkedin.
 */
export function r2KeyFor(opts: { slug: string; formatId: FormatId; ext?: string }): string {
  const { channel } = getFormat(opts.formatId)
  const purpose = channel === "ig" ? "instagram" : channel === "li" ? "linkedin" : "article"
  return brandImageKey({ purpose, slug: opts.slug, formatId: opts.formatId, ext: opts.ext })
}
