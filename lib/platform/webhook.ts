import { createHash, timingSafeEqual } from "node:crypto"

// Secret dos crons (route handlers acionados por GH Actions / cron do Coolify).
// Compara em tempo constante; hash antes p/ igualar tamanhos e não vazar o
// comprimento esperado. Espelha spa-sapienza/lib/auth/webhook.ts.

export function secretMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false
  const a = createHash("sha256").update(provided).digest()
  const b = createHash("sha256").update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Autoriza uma requisição de cron pelo header x-webhook-secret. */
export function cronAuthorized(req: Request): boolean {
  const expected = process.env.WEBHOOK_SECRET
  if (!expected) return false
  return secretMatches(req.headers.get("x-webhook-secret"), expected)
}
