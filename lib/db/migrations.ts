import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Migration } from "@/lib/platform/tenancy"

// Carrega as migrations de tenant (db/migrations/tenant/*.up.sql), ordenadas.
export function tenantMigrations(): Migration[] {
  const dir = join(process.cwd(), "db/migrations/tenant")
  return readdirSync(dir)
    .filter((f) => f.endsWith(".up.sql"))
    .sort()
    .map((name) => ({ name, body: readFileSync(join(dir, name), "utf8") }))
}
