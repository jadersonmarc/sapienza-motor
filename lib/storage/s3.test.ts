import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { isPublicAssetUrl } from "@/lib/storage/s3"

// Allowlist do que o servidor pode buscar a partir de entrada do usuário
// (`?image=` do /api/og). As imagens são servidas pelo proxy do motor, então a
// base permitida é MOTOR_PUBLIC_URL + /api/media/. Puro: não toca S3.

describe("isPublicAssetUrl", () => {
  const original = process.env.MOTOR_PUBLIC_URL
  beforeEach(() => {
    process.env.MOTOR_PUBLIC_URL = "https://motor.sapienza.com"
  })
  afterEach(() => {
    if (original === undefined) delete process.env.MOTOR_PUBLIC_URL
    else process.env.MOTOR_PUBLIC_URL = original
  })

  it("aceita URLs do proxy de mídia", () => {
    expect(isPublicAssetUrl("https://motor.sapienza.com/api/media/t1/social/instagram/post.png")).toBe(true)
    expect(isPublicAssetUrl("https://motor.sapienza.com/api/media/")).toBe(true)
  })

  it("recusa alvos internos (SSRF)", () => {
    expect(isPublicAssetUrl("http://localhost:3000/api/v1/content")).toBe(false)
    expect(isPublicAssetUrl("http://127.0.0.1/")).toBe(false)
    expect(isPublicAssetUrl("http://169.254.169.254/latest/meta-data/")).toBe(false)
    expect(isPublicAssetUrl("http://postgres:5432/")).toBe(false)
    expect(isPublicAssetUrl("file:///etc/passwd")).toBe(false)
  })

  it("recusa host que apenas começa com o nosso (prefixo não basta)", () => {
    expect(isPublicAssetUrl("https://motor.sapienza.com.evil.com/api/media/x.png")).toBe(false)
    expect(isPublicAssetUrl("https://evil.com/https://motor.sapienza.com/api/media/x.png")).toBe(false)
  })

  it("recusa outro path no mesmo host (fora de /api/media)", () => {
    expect(isPublicAssetUrl("https://motor.sapienza.com/api/v1/content")).toBe(false)
    expect(isPublicAssetUrl("https://motor.sapienza.com/privado/x.png")).toBe(false)
  })

  it("exige o mesmo protocolo", () => {
    expect(isPublicAssetUrl("http://motor.sapienza.com/api/media/x.png")).toBe(false)
  })

  it("recusa URL malformada, relativa ou vazia", () => {
    expect(isPublicAssetUrl("/api/media/x.png")).toBe(false)
    expect(isPublicAssetUrl("javascript:alert(1)")).toBe(false)
    expect(isPublicAssetUrl("")).toBe(false)
  })

  it("recusa tudo quando não há MOTOR_PUBLIC_URL (fail-closed)", () => {
    delete process.env.MOTOR_PUBLIC_URL
    expect(isPublicAssetUrl("https://motor.sapienza.com/api/media/x.png")).toBe(false)
  })
})
