// Tipos do Clipper — SEM dependência de DB, para serem seguros dentro do bundle
// Remotion (mesma regra de motion-types.ts). Persistidos em content_revisions.clip_props
// (jsonb, via tx.json). A composição de render consome clip_props direto: os `words`
// já vêm recortados e re-baseados ao tempo do clipe, então o render nunca toca o banco.

export type ClipAspect = "9x16" | "16x9"

export const CLIP_ASPECT_LIST: ClipAspect[] = ["9x16", "16x9"]

/** Palavra com alinhamento temporal (ms), base do karaokê e do casamento com o
 *  source_quote. Em clip_transcripts.words os tempos são absolutos (na fonte); em
 *  ClipProps.words são re-baseados ao início do clipe (0 = corte). */
export type TranscriptWord = {
  text: string
  startMs: number
  endMs: number
}

/** Janela de corte/enquadramento sobre a fonte, normalizada (0..1). Persistida por
 *  clipe e arrastável na UI (§3.4). scale=1 usa o frame inteiro. */
export type CropWindow = {
  x: number
  y: number
  scale: number
}

/** Estilo de legenda configurável (§3.3), integrado aos tokens Margot por default. */
export type CaptionStyle = {
  fontFamily?: string
  fontSizePct?: number // % da altura do vídeo
  color?: string
  outline?: boolean
  position?: "bottom" | "center" | "top"
  highlightColor?: string
}

/** Card de abertura com o gancho (reusa HeadlineBody do motion como overlay). */
export type OpeningCard = {
  words: string[]
  highlightIndex?: number
}

/** Overlay temporizado DENTRO do clipe (Onda 2) — hooks/B-roll reusando as
 *  composições do motion. Tempos em ms, relativos ao início do clipe. O card de dado
 *  carrega `source` (trecho literal da transcrição) só para auditoria do guardrail —
 *  não é exibido. */
export type ClipOverlay =
  | { kind: "quote"; startMs: number; endMs: number; quote: string; keyphrase?: string }
  | { kind: "stat"; startMs: number; endMs: number; label: string; value: number; suffix?: string; source: string }

/** Props de um clipe renderizável. Tudo que a composição Remotion precisa. */
export type ClipProps = {
  /** chave R2 do vídeo-fonte bruto (OffthreadVideo lê via proxy do motor). */
  sourceKey: string
  /** janela do corte na fonte (ms). */
  inMs: number
  outMs: number
  aspect: ClipAspect
  crop?: CropWindow
  caption: CaptionStyle
  /** palavras do trecho, re-baseadas a 0 = início do clipe. */
  words: TranscriptWord[]
  openingCard?: OpeningCard
  /** overlays temporizados dentro do clipe (citação/card de dado) — Onda 2. */
  overlays?: ClipOverlay[]
  /** aplica logo+handle do tenant (desligável por clipe). */
  brandOn: boolean
  /** score da análise (0–100, ordenação relativa) — para ranquear na grade. */
  score: number
}

// ── Contrato de saída da análise (SPEC §9) ────────────────────────────────────
// source_quote existe para VALIDAÇÃO: precisa bater como substring literal da
// transcrição, senão o corte é descartado (a IA não inventa momento). Os tempos por
// palavra NÃO são pedidos ao modelo — vêm da transcrição persistida.

export type ClipSuggestion = {
  clip_id: string
  title: string
  hook_text: string
  source_quote: string
  start_time: number // segundos
  end_time: number // segundos
  score: number // 0–100, ordenação RELATIVA dentro do vídeo (não é previsão)
  rationale: string
  suggested_aspect_ratio: "9:16" | "16:9"
}

export type ClipAnalysis = {
  clips: ClipSuggestion[]
}

/** Estágios da esteira de uma fonte (clip_sources.status). */
export type ClipSourceStatus =
  | "queued"
  | "downloading"
  | "probing"
  | "extracting_audio"
  | "transcribing"
  | "analyzing"
  | "generating"
  | "done"
  | "error"
