import type { Sql, Tx } from "@/lib/db"

// Espelha sapienza-kit/tenancy: schema-por-tenant `tenant_<uuid sem hífen>` +
// SET LOCAL search_path numa transação. Idêntico ao core/lib/provisioning.

const SCHEMA_RE = /^tenant_[0-9a-f]{32}$/

export function schemaName(tenantId: string): string {
  return "tenant_" + tenantId.replace(/-/g, "")
}

function assertSchema(schema: string): void {
  // Só aceitamos o nome derivado do uuid (evita DDL/identifier injection).
  if (!SCHEMA_RE.test(schema)) throw new Error(`tenantId inválido: ${schema}`)
}

/** Roda fn numa transação com search_path = tenant_<id>, public. */
export async function withTenant<T>(sql: Sql, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const schema = schemaName(tenantId)
  assertSchema(schema)
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO "${schema}", public`)
    return fn(tx)
  }) as Promise<T>
}

/** Cria o schema do tenant (idempotente). O core já cria no provisioning; isto é defensivo. */
export async function ensureSchema(sql: Sql, tenantId: string): Promise<void> {
  const schema = schemaName(tenantId)
  assertSchema(schema)
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
}

export type Migration = { name: string; body: string }

/** Aplica as migrations de tenant sob o search_path do tenant, rastreando
 *  schema_migrations por schema (forward-only, idempotente). */
export async function applyTenantMigrations(sql: Sql, tenantId: string, migrations: Migration[]): Promise<void> {
  await ensureSchema(sql, tenantId)
  await withTenant(sql, tenantId, async (tx) => {
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    )
  })
  for (const m of migrations) {
    await withTenant(sql, tenantId, async (tx) => {
      const done = await tx`SELECT 1 FROM schema_migrations WHERE name = ${m.name}`
      if (done.length > 0) return
      await tx.unsafe(m.body)
      await tx`INSERT INTO schema_migrations (name) VALUES (${m.name})`
    })
  }
}
