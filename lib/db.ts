import postgres from "postgres"

// Cliente Postgres único (lazy). O Motor compartilha o MESMO Postgres do core:
// `public` é do control plane (só lê); `tenant_<id>` são as tabelas do Motor.
let _sql: ReturnType<typeof postgres> | null = null

export function getDb(): ReturnType<typeof postgres> {
  if (_sql) return _sql
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL não definida")
  _sql = postgres(url, { prepare: false })
  return _sql
}

export type Sql = postgres.Sql
export type Tx = postgres.TransactionSql
