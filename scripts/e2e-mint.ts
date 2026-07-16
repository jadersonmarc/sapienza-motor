import { SignJWT } from "jose"

// Utilitário de verificação e2e: emite um JWT curto do produto (mesmo formato que o
// core, lib/auth/product-jwt) para exercer a API do Motor por HTTP. Segredo em
// PRODUCT_JWT_SECRET (compartilhado com o core).
//
//   PRODUCT_JWT_SECRET=... tsx scripts/e2e-mint.ts <tenantId> [userId]
async function main() {
  const [tid, uid = crypto.randomUUID()] = process.argv.slice(2)
  if (!tid) throw new Error("informe o tenantId")
  const s = process.env.PRODUCT_JWT_SECRET
  if (!s) throw new Error("PRODUCT_JWT_SECRET não definida")
  const jwt = await new SignJWT({ uid, tid, produto: "motor", role: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("sapienza-core")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(s))
  process.stdout.write(jwt)
}

main().catch((e) => {
  console.error("e2e-mint falhou:", e)
  process.exit(1)
})
