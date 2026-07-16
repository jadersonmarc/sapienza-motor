import type { Field } from "./tokens"

// Pilar → tratamento (função pura). No Motor o pilar é texto livre em
// content_items.pilar (nullable), então mapeamos os pilares conhecidos e caímos
// num default on-brand (campo surface / rótulo CONTEÚDO). Adaptado do spa-sapienza
// (que tinha um enum fechado engenharia|pme|bastidores).
export type Pilar = string | null

export function pillarStyle(pilar: Pilar): { tag: string; field: Field } {
  switch (pilar) {
    case "engenharia":
      return { tag: "ENG/AI", field: "ink" }
    case "pme":
    case "negocio":
      return { tag: "NEGÓCIO", field: "surface" }
    case "bastidores":
      return { tag: "BASTIDORES", field: "ink" }
    default:
      return { tag: "CONTEÚDO", field: "surface" }
  }
}
