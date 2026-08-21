// Scrim ADAPTATIVO das imagens de fundo do motion (item 7). Percentual fixo não
// garante legibilidade — foto clara + texto claro fica ilegível e vai publicado com
// a marca do cliente. Então: a tabela por preset é o PISO; a luminância média da
// imagem (0..1, calculada no worker via ffmpeg) sobe o scrim quando a imagem é clara.

export const SCRIM_FLOOR: Record<string, number> = {
  headline: 0.55, // palavras que montam — protagonistas, precisam saltar
  stat: 0.55, // o número domina
  quote: 0.4, // leitura corrida
  slides: 0.4, // títulos curtos
  story: 0.45, // roteiro multi-cena
}

/** Opacidade do scrim (0..0.85) para um preset e a luminância média da imagem. */
export function scrimForPreset(preset: string, lum: number): number {
  const floor = SCRIM_FLOOR[preset] ?? 0.5
  const l = Math.max(0, Math.min(1, lum))
  const adaptive = 0.35 + l * 0.5 // lum 0 → 0.35 ; lum 1 → 0.85
  return Math.min(0.85, Math.max(floor, adaptive))
}

/** Extrai a chave do R2 da URL pública de mídia (`MOTOR_PUBLIC_URL/api/media/<tenant>/<key>`).
 *  O worker busca a imagem DIRETO do R2 por essa chave — sem HEAD numa URL que ele pode
 *  não alcançar. null se a URL não segue o formato (aí não há como buscar). */
export function mediaKeyFromUrl(url: string): string | null {
  const m = url.match(/\/api\/media\/[^/]+\/(.+)$/)
  return m ? m[1] : null
}

/** Monta o data URI da imagem — o render (Chromium do Remotion) embute os bytes, sem
 *  buscar rede. Independe de qualquer URL pública estar acessível do worker. */
export function imageDataUri(contentType: string | undefined, bytes: Uint8Array): string {
  return `data:${contentType ?? "image/jpeg"};base64,${Buffer.from(bytes).toString("base64")}`
}
