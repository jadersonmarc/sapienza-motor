import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { isPublicAssetUrl } from "@/lib/storage/s3"

// Allowlist do que o servidor pode buscar a partir de entrada do usuário
// (`?image=` do /api/og). Puro: não toca S3.

describe("isPublicAssetUrl", () => {
  const original = process.env.S3_PUBLIC_URL
  beforeEach(() => {
    process.env.S3_PUBLIC_URL = "https://cdn.sapienza.com/midia"
  })
  afterEach(() => {
    if (original === undefined) delete process.env.S3_PUBLIC_URL
    else process.env.S3_PUBLIC_URL = original
  })

  it("aceita URLs do bucket público", () => {
    expect(isPublicAssetUrl("https://cdn.sapienza.com/midia/social/ig/post.png")).toBe(true)
    expect(isPublicAssetUrl("https://cdn.sapienza.com/midia/")).toBe(true)
  })

  it("recusa alvos internos (SSRF)", () => {
    expect(isPublicAssetUrl("http://localhost:3000/api/v1/content")).toBe(false)
    expect(isPublicAssetUrl("http://127.0.0.1/")).toBe(false)
    expect(isPublicAssetUrl("http://169.254.169.254/latest/meta-data/")).toBe(false)
    expect(isPublicAssetUrl("http://postgres:5432/")).toBe(false)
    expect(isPublicAssetUrl("file:///etc/passwd")).toBe(false)
  })

  it("recusa host que apenas começa com o nosso (prefixo não basta)", () => {
    expect(isPublicAssetUrl("https://cdn.sapienza.com.evil.com/midia/x.png")).toBe(false)
    expect(isPublicAssetUrl("https://evil.com/https://cdn.sapienza.com/midia/x.png")).toBe(false)
  })

  it("recusa outro path no mesmo host", () => {
    expect(isPublicAssetUrl("https://cdn.sapienza.com/privado/x.png")).toBe(false)
  })

  it("exige o mesmo protocolo", () => {
    expect(isPublicAssetUrl("http://cdn.sapienza.com/midia/x.png")).toBe(false)
  })

  it("recusa URL malformada, relativa ou vazia", () => {
    expect(isPublicAssetUrl("/midia/x.png")).toBe(false)
    expect(isPublicAssetUrl("javascript:alert(1)")).toBe(false)
    expect(isPublicAssetUrl("")).toBe(false)
  })

  it("recusa tudo quando não há bucket configurado (fail-closed)", () => {
    delete process.env.S3_PUBLIC_URL
    expect(isPublicAssetUrl("https://cdn.sapienza.com/midia/x.png")).toBe(false)
  })
})
