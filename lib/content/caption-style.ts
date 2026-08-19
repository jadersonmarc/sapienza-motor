// Estilo de legenda COMPARTILHADO pelo Clipper e pelo Motion (mesmo repo — unificado
// em vez de duplicado). RESTRITO A TOKENS: nada de CSS/hex livre.
// - fonte: papel tipográfico da marca (display/sans/mono).
// - cor / realce: cores SEMÂNTICAS (padrão/acento/signal) — resolvidas a hex no
//   contexto (over-vídeo do clipper vs campo do motion), impossível escolher combo
//   ilegível.
// - tamanho / posição: usados pelo CLIPPER; o Motion (8a) NÃO os aplica (layout
//   bespoke dos presets fica intocado).
// - outline: extensão do clipper (contraste sobre vídeo).
import { fieldStyle, fonts, colors, type Field } from "@/lib/brand/tokens"

export type CaptionFont = "display" | "sans" | "mono"
export type CaptionColor = "default" | "accent" | "signal"
export type CaptionPosition = "top" | "center" | "bottom"
export type CaptionSize = "sm" | "md" | "lg"

export type CaptionStyle = {
  font?: CaptionFont
  color?: CaptionColor
  highlight?: CaptionColor
  size?: CaptionSize
  position?: CaptionPosition
  outline?: boolean
}

/** hex de uma cor semântica; `default`/undefined cai no fallback do contexto. */
function semanticHex(name: CaptionColor | undefined, fallback: string): string {
  if (name === "accent") return colors.petrolSoft.hex
  if (name === "signal") return colors.signal.hex
  return fallback // "default" ou undefined
}

/** Resolve fonte + cor do texto + cor de realce a valores concretos. `textFallback`
 *  e `highlightFallback` são os defaults do CONTEXTO (motion = fg/accent do campo;
 *  clipper = branco/signal sobre o vídeo). Sem estilo → devolve os fallbacks =
 *  comportamento atual byte a byte. */
export function resolveCaption(
  style: CaptionStyle | undefined,
  fallbacks: { textFallback: string; highlightFallback: string },
): { fontFamily: string; color: string; highlight: string } {
  return {
    fontFamily: style?.font ? fonts[style.font] : fonts.display,
    color: semanticHex(style?.color, fallbacks.textFallback),
    highlight: semanticHex(style?.highlight, fallbacks.highlightFallback),
  }
}

/** Fallbacks do MOTION a partir do campo (ink/surface): default = fg, realce = accent. */
export function motionFallbacks(field: Field): { textFallback: string; highlightFallback: string } {
  const fs = fieldStyle[field]
  return { textFallback: fs.fg, highlightFallback: fs.accent }
}

/** % da altura do vídeo por tamanho (clipper). md = 5.2 (valor atual). */
export function captionSizePct(size: CaptionSize | undefined): number {
  return size === "sm" ? 4.5 : size === "lg" ? 6.5 : 5.2
}

const CAPTION_FONTS: readonly CaptionFont[] = ["display", "sans", "mono"]
const CAPTION_COLORS: readonly CaptionColor[] = ["default", "accent", "signal"]

/** Guardrail de escrita do MOTION: aceita só fonte/cor/realce dentro dos tokens
 *  (descarta qualquer CSS livre). Vazio → null (= usa o default do tenant/atual). */
export function sanitizeCaptionStyle(raw: unknown): CaptionStyle | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const out: CaptionStyle = {}
  if (CAPTION_FONTS.includes(r.font as CaptionFont)) out.font = r.font as CaptionFont
  if (CAPTION_COLORS.includes(r.color as CaptionColor)) out.color = r.color as CaptionColor
  if (CAPTION_COLORS.includes(r.highlight as CaptionColor)) out.highlight = r.highlight as CaptionColor
  return Object.keys(out).length > 0 ? out : null
}
