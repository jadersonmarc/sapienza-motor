import type { Sql } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"

// Uma imagem está referenciada por alguma peça? Guard antes de excluir/mover na
// biblioteca. Tenant-scoped (withTenant). Fontes no schema do Motor:
//  - social_drafts.image_url  (imagem do post social)
//  - content_revisions.body_markdown  (imagem embutida no corpo)

export type ImageRefs = { total: number; social: number; markdown: number }

export async function findImageReferences(sql: Sql, tenantId: string, url: string): Promise<ImageRefs> {
  return withTenant(sql, tenantId, async (tx) => {
    const [s] = (await tx`
      SELECT COUNT(*)::int AS n FROM social_drafts WHERE image_url = ${url}
    `) as unknown as { n: number }[]
    const [m] = (await tx`
      SELECT COUNT(*)::int AS n FROM content_revisions WHERE body_markdown LIKE '%' || ${url} || '%'
    `) as unknown as { n: number }[]
    const social = s?.n ?? 0
    const markdown = m?.n ?? 0
    return { total: social + markdown, social, markdown }
  })
}
