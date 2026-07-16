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

/** Valida o JWT do core (produto motor ou vazio) e retorna claims, ou uma Response de erro. */
export async function authed(req: Request): Promise<Authed | Response> {
  const tok = bearer(req.headers.get("authorization"))
  if (!tok) return json(401, { error: "missing bearer token" })
  let claims
  try {
    claims = await verifyProductToken(tok)
  } catch {
    return json(401, { error: "invalid token" })
  }
  if (claims.produto && claims.produto !== PRODUTO) {
    return json(403, { error: "token not scoped to motor" })
  }
  return { tenantId: claims.tenantId, userId: claims.userId, role: claims.role }
}

export function isResponse(x: unknown): x is Response {
  return x instanceof Response
}
