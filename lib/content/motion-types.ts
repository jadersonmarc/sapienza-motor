// Tipos compartilhados dos presets de MOTION — fonte única usada tanto pelo
// gerador (lib/ai/motion.ts) quanto pelas compositions do Remotion (motion/).
// Sem dependência de SDK/DB: seguro de importar no bundle do Remotion.
import type { MotionMood } from "./motion-audio"

// `story` é o preset multi-cena (roteiro hook→desenvolvimento→CTA); os demais são os
// presets de cena única (mantidos por compat e reusados como BLOCOS de cena do story).
export type MotionPreset = "headline" | "quote" | "slides" | "stat" | "story"
export type MotionAspect = "1x1" | "4x5" | "9x16"

export const MOTION_PRESETS: readonly MotionPreset[] = ["headline", "quote", "slides", "stat", "story"]
export const MOTION_ASPECTS: readonly MotionAspect[] = ["1x1", "4x5", "9x16"]

// Fan-out: da mesma peça, renderiza o formato PRINCIPAL (o que a IA escolheu) +
// Stories/Reels (9x16) + feed (1x1). Dedup preservando a ordem (principal 1º).
export function fanoutAspects(primary: MotionAspect): MotionAspect[] {
  const out: MotionAspect[] = []
  for (const a of [primary, "9x16", "1x1"] as MotionAspect[]) if (!out.includes(a)) out.push(a)
  return out
}

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

// Afirmação com rótulo — primitiva dos arquétipos (Mito/Verdade, Antes/Depois,
// item de lista, resposta). Chip de rótulo (opcional) + frase grande.
export type StatementProps = { kind: "statement"; label?: string; text: string }

// Arquétipos de vídeo: cada um monta uma sequência de cenas própria a partir dos
// blocos. `highlight` é o arco genérico (hook→desenvolvimento→CTA).
export type MotionArchetype = "highlight" | "list" | "myth_fact" | "before_after" | "qa"
export const MOTION_ARCHETYPES: readonly MotionArchetype[] = [
  "highlight",
  "list",
  "myth_fact",
  "before_after",
  "qa",
]

// Campo cromático da peça (espelha lib/brand/tokens: ink = escuro, surface = claro).
export type MotionField = "ink" | "surface"

// Papel da cena no arco narrativo do vídeo.
export type SceneRole = "hook" | "develop" | "cta"

// Blocos que uma cena pode conter (presets de cena única + statement + CTA).
export type SceneBlock = HeadlineProps | QuoteProps | SlidesProps | StatProps | StatementProps | CtaProps

// Uma cena do roteiro: papel + duração (segundos) + o bloco a animar.
export type MotionScene = { role: SceneRole; durSec: number; block: SceneBlock }

// Roteiro multi-cena — o que o preset `story` renderiza via <Series>. `audio` é o
// mood da trilha (ver motion-audio); ausente/"none" = mudo.
export type StoryProps = { kind: "story"; scenes: MotionScene[]; theme?: MotionField; audio?: MotionMood }

export type MotionProps = HeadlineProps | QuoteProps | SlidesProps | StatProps | StoryProps
