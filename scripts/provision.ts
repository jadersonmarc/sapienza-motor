import { getDb } from "@/lib/db"
import { catchUp, processOutbox } from "@/lib/provisioning"

// Boot idempotente: aplica as migrations de tenant para todos os assinantes motor
// ativos (catch-up) e drena o outbox uma vez. Rodado no start do container, antes
// do `next start`. Ativações posteriores são drenadas por /api/cron/provision.
async function main() {
  const sql = getDb()
  await catchUp(sql)
  let drained = 0
  for (;;) {
    const n = await processOutbox(sql)
    drained += n
    if (n === 0) break
  }
  console.log(`[motor] provision: catch-up ok, outbox drenado (${drained} eventos)`)
  await sql.end()
}

main().catch((e) => {
  console.error("[motor] provision falhou:", e)
  process.exit(1)
})
