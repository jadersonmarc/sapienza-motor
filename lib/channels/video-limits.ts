import type { Platform } from "./types"

// Limites de duração/tamanho de vídeo por canal (§3.9). Validados ANTES de enfileirar
// a publicação — um clipe que não cabe num canal avisa em vez de estourar 400/422
// silencioso na API da plataforma. Valores conservadores das specs das plataformas
// (não existiam no repo); a calibrar. Canais sem entrada = sem limite conhecido.

type VideoLimit = { minSec?: number; maxSec?: number; maxBytes?: number }

const GB = 1024 * 1024 * 1024

const LIMITS: Partial<Record<Platform, VideoLimit>> = {
  // Instagram Reels: 3s–15min, ~1GB.
  instagram: { minSec: 3, maxSec: 15 * 60, maxBytes: 1 * GB },
  // LinkedIn vídeo nativo: até 30min, arquivos grandes (conservador 5GB).
  linkedin: { maxSec: 30 * 60, maxBytes: 5 * GB },
  // Webhook encaminha a URL — sem limite nosso.
}

export type ClipFit = { ok: true } | { ok: false; reason: string }

/** O clipe cabe no canal? Canal sem limite conhecido passa. */
export function clipFitsChannel(platform: Platform, clip: { durationSec: number; sizeBytes?: number }): ClipFit {
  const lim = LIMITS[platform]
  if (!lim) return { ok: true }
  if (lim.minSec != null && clip.durationSec < lim.minSec) {
    return { ok: false, reason: `muito curto para ${platform} (mín. ${lim.minSec}s)` }
  }
  if (lim.maxSec != null && clip.durationSec > lim.maxSec) {
    return { ok: false, reason: `muito longo para ${platform} (máx. ${Math.round(lim.maxSec / 60)}min)` }
  }
  if (lim.maxBytes != null && clip.sizeBytes != null && clip.sizeBytes > lim.maxBytes) {
    return { ok: false, reason: `arquivo grande demais para ${platform} (máx. ${Math.round(lim.maxBytes / GB)}GB)` }
  }
  return { ok: true }
}
