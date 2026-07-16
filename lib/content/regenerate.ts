import type { Sql } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { productRules } from "@/lib/platform/gating"
import { getItem, addRevision } from "./store"

// Regeneração por IA com limite (max_regeneracoes_por_peca, default 2). A geração
// em si (Claude) é um seam injetável (stub nos testes; real no pipeline).

const DEFAULT_MAX_REGEN = 2

export class RegenLimitError extends Error {}

export type GeneratedContent = { title: string; bodyMarkdown: string; excerpt?: string }

export async function regenerate(
  sql: Sql,
  tenantId: string,
  itemId: string,
  generate: () => Promise<GeneratedContent>,
): Promise<string> {
  const rules = await productRules(sql)
  const maxRegen = Number(rules["max_regeneracoes_por_peca"] ?? DEFAULT_MAX_REGEN)

  const count = await withTenant(sql, tenantId, async (tx) => {
    const item = await getItem(tx, itemId)
    if (!item) throw new RegenLimitError("peça não encontrada")
    return item.regen_count
  })
  if (count >= maxRegen) {
    throw new RegenLimitError(
      `limite de ${maxRegen} regenerações atingido; a próxima é pedido customizado (excedente)`,
    )
  }

  const content = await generate() // seam da IA (fora de transação)
  return withTenant(sql, tenantId, async (tx) =>
    addRevision(tx, itemId, {
      title: content.title,
      bodyMarkdown: content.bodyMarkdown,
      excerpt: content.excerpt,
      ai: true,
    }),
  )
}
