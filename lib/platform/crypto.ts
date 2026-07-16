import crypto from "node:crypto"

// AES-256-GCM para credenciais de canal por-tenant em repouso.
// Formato "iv:tag:ciphertext" (cada parte base64) — COMPATÍVEL com
// spa-sapienza/lib/agent/crypto.ts e margot/internal/secrets. Chave MOTOR_ENC_KEY.

const ALGO = "aes-256-gcm"

function key(): Buffer {
  const b64 = process.env.MOTOR_ENC_KEY
  if (!b64) throw new Error("MOTOR_ENC_KEY não definida")
  const k = Buffer.from(b64, "base64")
  if (k.length !== 32) {
    throw new Error("MOTOR_ENC_KEY deve ter 32 bytes (base64) — gere com: openssl rand -base64 32")
  }
  return k
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, key(), iv)
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, ct].map((b) => b.toString("base64")).join(":")
}

export function decryptSecret(enc: string): string {
  const [ivB, tagB, ctB] = enc.split(":")
  if (!ivB || !tagB || !ctB) throw new Error("segredo criptografado inválido")
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB, "base64"))
  decipher.setAuthTag(Buffer.from(tagB, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8")
}
