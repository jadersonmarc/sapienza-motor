import type { Format } from "../formats"
import { minType } from "../tokens"

// Geometria derivada do formato: margem de segurança (~7.5% do lado menor),
// faixa segura extra dos stories e tamanho do trilho mono (nunca < mínimo).
export function metrics(f: Format) {
  const min = Math.min(f.w, f.h)
  return {
    margin: Math.round(min * 0.075),
    safeY: Math.round(f.h * f.safe),
    mono: Math.max(minType.mono, Math.round(f.w * 0.0185)),
  }
}
