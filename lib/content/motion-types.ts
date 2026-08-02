// Tipos compartilhados dos presets de MOTION — fonte única usada tanto pelo
// gerador (lib/ai/motion.ts) quanto pelas compositions do Remotion (motion/).
// Sem dependência de SDK/DB: seguro de importar no bundle do Remotion.

// `story` é o preset multi-cena (roteiro hook→desenvolvimento→CTA); os demais são os
// presets de cena única (mantidos por compat e reusados como BLOCOS de cena do story).
export type MotionPreset = "headline" | "quote" | "slides" | "stat" | "story"
export type MotionAspect = "1x1" | "4x5" | "9x16"

export const MOTION_PRESETS: readonly MotionPreset[] = ["headline", "quote", "slides", "stat", "story"]
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
// Chamada à ação — cena final do roteiro. Convite curto + handle.
export type CtaProps = { kind: "cta"; text: string; handle?: string }

// Campo cromático da peça (espelha lib/brand/tokens: ink = escuro, surface = claro).
export type MotionField = "ink" | "surface"

// Papel da cena no arco narrativo do vídeo.
export type SceneRole = "hook" | "develop" | "cta"

// Blocos que uma cena pode conter (reusam os presets de cena única + CTA).
export type SceneBlock = HeadlineProps | QuoteProps | SlidesProps | StatProps | CtaProps

// Uma cena do roteiro: papel + duração (segundos) + o bloco a animar.
export type MotionScene = { role: SceneRole; durSec: number; block: SceneBlock }

// Roteiro multi-cena — o que o preset `story` renderiza via <Series>.
export type StoryProps = { kind: "story"; scenes: MotionScene[]; theme?: MotionField }

export type MotionProps = HeadlineProps | QuoteProps | SlidesProps | StatProps | StoryProps
