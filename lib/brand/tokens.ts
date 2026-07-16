// Fonte ÚNICA dos valores de marca para o renderer de imagens.
//
// Satori (next/og) NÃO lê CSS variables — então o renderer importa daqui o
// sRGB já resolvido. O site/admin continuam usando as CSS vars OKLCH em
// `app/globals.css`; `tokens.test.ts` falha se os OKLCH abaixo divergirem da
// var correspondente, garantindo que a marca não bifurque entre os dois lugares.

export interface BrandToken {
  /** sRGB hex que o Satori/next-og consome no canvas. */
  hex: string
  /**
   * OKLCH canônico — deve bater, caractere a caractere, com a CSS var
   * ancorada em `cssVar` (ver `tokens.test.ts`).
   */
  oklch: string
  /** Var de `app/globals.css` que espelha este token (escopo + nome sem `--`). */
  cssVar: { scope: ":root" | ".dark"; name: string }
}

export const colors = {
  /** Campo de autoridade (Eng/AI, técnico). */
  ink: { hex: "#0E1116", oklch: "oklch(0.16 0.012 255)", cssVar: { scope: ".dark", name: "background" } },
  /** Campo de clareza (PME, didático). */
  surface: { hex: "#F7F8FA", oklch: "oklch(0.984 0.003 247)", cssVar: { scope: ":root", name: "background" } },
  /** Único acento — uma vez por peça. */
  petrol: { hex: "#0E6E73", oklch: "oklch(0.47 0.085 192)", cssVar: { scope: ":root", name: "primary" } },
  /** Acento/rótulo legível sobre `ink`. */
  petrolSoft: { hex: "#3A9BA0", oklch: "oklch(0.62 0.08 192)", cssVar: { scope: ".dark", name: "primary" } },
  /** Grade e divisores sobre `surface`. */
  line: { hex: "#D7DCE2", oklch: "oklch(0.9 0.005 247)", cssVar: { scope: ":root", name: "border" } },
  /** Grade e divisores sobre `ink`. */
  lineDark: { hex: "#222833", oklch: "oklch(0.28 0.012 255)", cssVar: { scope: ".dark", name: "border" } },
  /** Alerta pontual — quase nunca numa peça. */
  signal: { hex: "#C9683A", oklch: "oklch(0.6 0.13 45)", cssVar: { scope: ":root", name: "signal" } },
} as const satisfies Record<string, BrandToken>

export type ColorName = keyof typeof colors

/** Os dois únicos campos-base de uma peça (sem terceira opção, sem gradiente). */
export type Field = "ink" | "surface"

/** Overlay sólido (sem gradiente) — ink @ 50% p/ esfriar foto e dar legibilidade. */
export const scrim = { ink: "rgba(14, 17, 22, 0.5)" } as const

/** Texto/grade/acento de cada campo — derivado dos tokens, nunca hardcoded. */
export const fieldStyle = {
  ink: { bg: colors.ink.hex, fg: colors.surface.hex, line: colors.lineDark.hex, accent: colors.petrolSoft.hex },
  surface: { bg: colors.surface.hex, fg: colors.ink.hex, line: colors.line.hex, accent: colors.petrol.hex },
} as const satisfies Record<Field, { bg: string; fg: string; line: string; accent: string }>

// Tipografia (famílias resolvidas em assets/fonts pelo renderer).
export const fonts = {
  display: "Bricolage Grotesque",
  sans: "IBM Plex Sans",
  mono: "IBM Plex Mono",
} as const

/** Tamanhos mínimos no canvas-base 1080 (degradam, nunca abaixo disto). */
export const minType = { title: 64, support: 28, mono: 22 } as const
