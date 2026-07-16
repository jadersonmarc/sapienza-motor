// Helpers puros de texto do post social (sem DB/auth) — testáveis isoladamente.
// Copiado de spa-sapienza/lib/content/social-text.

// Normaliza a entrada de hashtags (texto livre) em lista: remove `#`, separa por
// espaço/vírgula, descarta vazios e deduplica preservando a ordem.
export function parseHashtags(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[\s,]+/)
        .map((t) => t.replace(/^#+/, "").trim())
        .filter(Boolean),
    ),
  )
}
