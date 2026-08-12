import { describe, it, expect } from "vitest"
import { clipFitsChannel } from "./video-limits"

describe("clipFitsChannel", () => {
  it("webhook não tem limite conhecido → sempre cabe", () => {
    expect(clipFitsChannel("webhook", { durationSec: 99999 }).ok).toBe(true)
  })

  it("instagram: rejeita curto demais e longo demais", () => {
    expect(clipFitsChannel("instagram", { durationSec: 2 }).ok).toBe(false) // <3s
    expect(clipFitsChannel("instagram", { durationSec: 16 * 60 }).ok).toBe(false) // >15min
    expect(clipFitsChannel("instagram", { durationSec: 60 }).ok).toBe(true)
  })

  it("instagram: rejeita arquivo acima de 1GB", () => {
    const r = clipFitsChannel("instagram", { durationSec: 60, sizeBytes: 2 * 1024 * 1024 * 1024 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/grande/)
  })

  it("linkedin: aceita até 30min", () => {
    expect(clipFitsChannel("linkedin", { durationSec: 20 * 60 }).ok).toBe(true)
    expect(clipFitsChannel("linkedin", { durationSec: 31 * 60 }).ok).toBe(false)
  })
})
