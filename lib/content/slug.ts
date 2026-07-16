// Gera um slug seguro (minúsculas, hifens, sem acentos). Lógica pura.
// Copiado de spa-sapienza/lib/content/slug.ts.
export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove diacríticos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}
