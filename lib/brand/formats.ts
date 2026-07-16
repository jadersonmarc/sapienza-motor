// Presets de formato — espelham a tabela mestre do guia (canal × aspecto).
// Render na resolução-base; `safe` reserva as faixas de UI (stories).

export type Channel = "blog" | "ig" | "li"
export type Aspect = "16x9" | "191x1" | "1x1" | "4x5" | "9x16"

export interface Format {
  channel: Channel
  /** Rótulo humano do preset. */
  label: string
  aspect: Aspect
  w: number
  h: number
  /** Fração do lado menor reservada nas bordas (UI dos stories). 0 = sem reserva. */
  safe: number
}

export const formats = {
  "blog-hero": { channel: "blog", label: "Capa do post", aspect: "16x9", w: 1600, h: 900, safe: 0 },
  "blog-og": { channel: "blog", label: "OG (preview de link)", aspect: "191x1", w: 1200, h: 630, safe: 0 },

  "ig-feed": { channel: "ig", label: "Feed retrato", aspect: "4x5", w: 1080, h: 1350, safe: 0 },
  "ig-square": { channel: "ig", label: "Feed quadrado", aspect: "1x1", w: 1080, h: 1080, safe: 0 },
  "ig-carousel": { channel: "ig", label: "Carrossel", aspect: "4x5", w: 1080, h: 1350, safe: 0 },
  "ig-story": { channel: "ig", label: "Stories/Reels", aspect: "9x16", w: 1080, h: 1920, safe: 0.13 },

  "li-feed": { channel: "li", label: "Feed", aspect: "1x1", w: 1200, h: 1200, safe: 0 },
  "li-link": { channel: "li", label: "Link/artigo (capa)", aspect: "191x1", w: 1200, h: 627, safe: 0 },
  "li-doc": { channel: "li", label: "Documento (carrossel)", aspect: "4x5", w: 1080, h: 1350, safe: 0 },
  "li-article": { channel: "li", label: "Capa de artigo (nativo)", aspect: "16x9", w: 1920, h: 1080, safe: 0 },
} as const satisfies Record<string, Format>

export type FormatId = keyof typeof formats

export function getFormat(id: FormatId): Format {
  return formats[id]
}
