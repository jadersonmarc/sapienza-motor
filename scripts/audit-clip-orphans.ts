// Auditoria READ-ONLY de órfãos do Clipper no R2 (item 6.5). NÃO apaga nada — só
// lista e relata. Um objeto é órfão quando existe no bucket mas NENHUM registro no
// banco o referencia:
//   - `clips/<slug>.mp4`      → clipe renderizado sem content_item (is_clip) correspondente.
//   - `clips/raw/<ref>.<ext>` → vídeo-fonte bruto sem clip_sources.r2_key_raw apontando.
// Rode com as envs de PRODUÇÃO (DATABASE_URL + S3_*/MOTOR_PUBLIC_URL). O número serve
// para decidir, caso a caso, se vale uma limpeza — que NÃO é automatizada aqui.
//
//   pnpm tsx scripts/audit-clip-orphans.ts            # todos os tenants ativos
//   pnpm tsx scripts/audit-clip-orphans.ts <tenantId> # um tenant

import { getDb } from "@/lib/db"
import { activeTenants } from "@/lib/platform/gating"
import { withTenant } from "@/lib/platform/tenancy"
import { listObjects, isStorageConfigured, type StoredObject } from "@/lib/storage/s3"
import { clipVideoKey } from "@/lib/storage/keys"

const RAW_PREFIX = "clips/raw/"

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function listAllClipObjects(tenantId: string): Promise<StoredObject[]> {
  const all: StoredObject[] = []
  let token: string | undefined
  do {
    const res = await listObjects(tenantId, "clips", { token, max: 1000 })
    all.push(...res.objects)
    token = res.nextToken
  } while (token)
  return all
}

type TenantReport = { tenantId: string; rendered: number; raw: number; bytes: number }

async function auditTenant(sql: ReturnType<typeof getDb>, tenantId: string): Promise<TenantReport> {
  const objects = await listAllClipObjects(tenantId)

  const { slugs, raws } = await withTenant(sql, tenantId, async (tx) => {
    const s = (await tx`SELECT slug FROM content_items WHERE is_clip = true`) as unknown as { slug: string }[]
    const r = (await tx`SELECT r2_key_raw FROM clip_sources WHERE r2_key_raw IS NOT NULL`) as unknown as {
      r2_key_raw: string
    }[]
    return { slugs: s.map((x) => x.slug), raws: new Set(r.map((x) => x.r2_key_raw)) }
  })
  const expectedRendered = new Set(slugs.map((slug) => clipVideoKey({ slug })))

  const report: TenantReport = { tenantId, rendered: 0, raw: 0, bytes: 0 }
  const orphanKeys: string[] = []
  for (const o of objects) {
    const isRaw = o.key.startsWith(RAW_PREFIX)
    const referenced = isRaw ? raws.has(o.key) : expectedRendered.has(o.key)
    if (referenced) continue
    if (isRaw) report.raw++
    else report.rendered++
    report.bytes += o.size ?? 0
    orphanKeys.push(`${o.key} (${mb(o.size ?? 0)})`)
  }

  if (report.rendered + report.raw > 0) {
    console.log(
      `\n[tenant ${tenantId}] órfãos: ${report.rendered} clipe(s) + ${report.raw} bruto(s) = ${mb(report.bytes)}`,
    )
    for (const k of orphanKeys) console.log(`  - ${k}`)
  } else {
    console.log(`[tenant ${tenantId}] sem órfãos`)
  }
  return report
}

async function main(): Promise<void> {
  if (!isStorageConfigured()) {
    console.error("storage R2 não configurado (S3_* / MOTOR_PUBLIC_URL) — nada a auditar")
    process.exit(1)
  }
  const sql = getDb()
  const arg = process.argv[2]
  const tenants = arg ? [arg] : await activeTenants(sql)
  console.log(`Auditando ${tenants.length} tenant(s) — READ-ONLY, nada será apagado.`)

  const totals = { rendered: 0, raw: 0, bytes: 0 }
  for (const t of tenants) {
    const r = await auditTenant(sql, t)
    totals.rendered += r.rendered
    totals.raw += r.raw
    totals.bytes += r.bytes
  }

  console.log(
    `\n=== TOTAL: ${totals.rendered} clipe(s) órfão(s) + ${totals.raw} bruto(s) órfão(s) = ${mb(totals.bytes)} ===`,
  )
  console.log("Nenhuma limpeza foi executada. Decida caso a caso.")
  await sql.end()
}

main().catch((e) => {
  console.error("auditoria falhou:", e)
  process.exit(1)
})
