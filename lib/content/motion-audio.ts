// Catálogo de trilhas do MOTION — fonte única de mood/arquivo/BPM, sem dependência
// de SDK/DB (seguro de importar tanto no motor quanto no bundle do Remotion).
// A música em si é asset do operador (assets/audio/<file>); aqui só o metadado.

export type MotionMood = "none" | "calm" | "upbeat" | "bold"
export const MOTION_MOODS: readonly MotionMood[] = ["none", "calm", "upbeat", "bold"]

export type AudioTrack = { file: string; bpm: number }

// mood → faixa. Os arquivos vivem em assets/audio (copiados p/ public/audio); se
// ausentes, o worker renderiza mudo (seam). BPM alimenta o beat-sync (quantização).
export const AUDIO_TRACKS: Record<Exclude<MotionMood, "none">, AudioTrack> = {
  calm: { file: "calm.mp3", bpm: 90 },
  upbeat: { file: "upbeat.mp3", bpm: 120 },
  bold: { file: "bold.mp3", bpm: 100 },
}

/** Faixa de um mood (null para `none` ou mood desconhecido). */
export function trackFor(mood: MotionMood): AudioTrack | null {
  return mood === "none" ? null : (AUDIO_TRACKS[mood] ?? null)
}

/** Duração de uma batida em segundos. */
export function beatSec(bpm: number): number {
  return 60 / bpm
}

/** Ajusta uma duração (segundos) ao múltiplo de batida mais próximo (mín. 1 batida).
 *  É o beat-sync: cortes de cena caem na grade musical do BPM. */
export function quantizeToBeat(sec: number, bpm: number): number {
  const b = beatSec(bpm)
  return Math.max(b, Math.round(sec / b) * b)
}
