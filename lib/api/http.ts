import { verifyProductToken, bearer } from "@/lib/platform/authclient"
import { PRODUTO } from "@/lib/platform/gating"

// Helpers para os route handlers da API v1. Auth = JWT curto do core.

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export type Authed = { tenantId: string; userId: string; role: string }

/** Papéis do membership (core/lib/tenant/context.ts). Superadmin chega como owner. */
export type Role = "owner" | "admin" | "member"

/** Valida o JWT do core (escopado ao motor) e retorna claims, ou uma Response de erro. */
export async function authed(req: Request): Promise<Authed | Response> {
  const tok = bearer(req.headers.get("authorization"))
  if (!tok) return json(401, { error: "missing bearer token" })
  let claims
  try {
    claims = await verifyProductToken(tok)
  } catch {
    return json(401, { error: "invalid token" })
  }
  // Exige o escopo: antes, um token sem a claim `produto` passava (o `&&` só
  // barrava quando ela vinha preenchida com outro produto).
  if (claims.produto !== PRODUTO) {
    return json(403, { error: "token not scoped to motor" })
  }
  return { tenantId: claims.tenantId, userId: claims.userId, role: claims.role }
}

/**
 * Exige um dos papéis. Devolve Response de erro, ou null se pode seguir.
 * O core achata superadmin em "owner" ao emitir o token (lib/motor/client.ts).
 */
export function requireRole(a: Authed, allowed: Role[]): Response | null {
  if (!allowed.includes(a.role as Role)) {
    return json(403, { error: `requer papel ${allowed.join(" ou ")}` })
  }
  return null
}

export function isResponse(x: unknown): x is Response {
  return x instanceof Response
}
