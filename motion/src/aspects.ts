import type { MotionAspect } from "../../lib/content/motion-types"

// Canvas por aspecto (base 1080). Fase 1 mira feed (1:1, 4:5); 9:16 (story) fica
// buildável/previewable mas não é alvo de geração ainda.
export const ASPECTS: Record<MotionAspect, { w: number; h: number }> = {
  "1x1": { w: 1080, h: 1080 },
  "4x5": { w: 1080, h: 1350 },
  "9x16": { w: 1080, h: 1920 },
}

export const FPS = 30
export const DEFAULT_DURATION = 180 // ~6s, play único (presets de cena única)
export const ALL_ASPECTS: MotionAspect[] = ["1x1", "4x5", "9x16"]

/** Frames de uma cena a partir da duração em segundos (mín. 1). */
export function framesForSec(sec: number): number {
  return Math.max(1, Math.round(sec * FPS))
}

/** Duração total (frames) de um roteiro `story` = soma das cenas. Content-aware:
 *  usado pelo calculateMetadata da composition (selectComposition roda no render). */
export function storyDuration(scenes: { durSec: number }[]): number {
  const total = scenes.reduce((acc, s) => acc + framesForSec(s.durSec), 0)
  return Math.max(FPS, total) // nunca menor que ~1s
}
