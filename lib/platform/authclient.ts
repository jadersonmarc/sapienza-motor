import { jwtVerify } from "jose"

// Verifica o JWT curto emitido pelo core (core/lib/auth/product-jwt.ts, jose
// HS256, issuer "sapienza-core", claims uid/tid/produto/role). Espelha o
// sapienza-kit/authclient (Go). Segredo compartilhado PRODUCT_JWT_SECRET.

const ISSUER = "sapienza-core"

export type ProductClaims = {
  userId: string
  tenantId: string
  produto: string
  role: string
}

function secret(): Uint8Array {
  const s = process.env.PRODUCT_JWT_SECRET
  if (!s) throw new Error("PRODUCT_JWT_SECRET não definida")
  return new TextEncoder().encode(s)
}

/** Valida o token e retorna as claims; lança se inválido/expirado/issuer errado. */
export async function verifyProductToken(token: string): Promise<ProductClaims> {
  const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER })
  const uid = payload.uid as string | undefined
  const tid = payload.tid as string | undefined
  if (!uid || !tid) throw new Error("claims uid/tid ausentes")
  return {
    userId: uid,
    tenantId: tid,
    produto: (payload.produto as string) ?? "",
    role: (payload.role as string) ?? "",
  }
}

/** Extrai o bearer do header Authorization. */
export function bearer(header: string | null): string {
  if (!header) return ""
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : ""
}
