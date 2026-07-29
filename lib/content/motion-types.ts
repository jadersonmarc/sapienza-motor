// Tipos compartilhados dos presets de MOTION — fonte única usada tanto pelo
// gerador (lib/ai/motion.ts) quanto pelas compositions do Remotion (motion/).
// Sem dependência de SDK/DB: seguro de importar no bundle do Remotion.

export type MotionPreset = "headline" | "quote" | "slides" | "stat"
export type MotionAspect = "1x1" | "4x5" | "9x16"

export const MOTION_PRESETS: readonly MotionPreset[] = ["headline", "quote", "slides", "stat"]
export const MOTION_ASPECTS: readonly MotionAspect[] = ["1x1", "4x5", "9x16"]

export type HeadlineProps = { kind: "headline"; words: string[]; highlightIndex: number }
export type QuoteProps = { kind: "quote"; quote: string; keyphrase: string; author: string }
export type SlidesProps = { kind: "slides"; slides: { index: number; title: string }[] }
export type StatProps = {
  kind: "stat"
  label: string
  value: number
  suffix: string
  subtitle: string
  source: string
}
export type MotionProps = HeadlineProps | QuoteProps | SlidesProps | StatProps
