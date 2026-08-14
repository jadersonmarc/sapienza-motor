import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { authorizeUrl, isConnectorConfigured, exchangeCode, refresh } from "./clip-connectors"

const ENV = {
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsec",
  DROPBOX_APP_KEY: "dkey",
  DROPBOX_APP_SECRET: "dsec",
  OAUTH_REDIRECT_BASE: "https://console.x",
}

beforeEach(() => Object.assign(process.env, ENV))
afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k as keyof typeof ENV]
  vi.unstubAllGlobals()
})

describe("clip-connectors OAuth", () => {
  it("seam: sem env do app, não está configurado", () => {
    delete process.env.GOOGLE_CLIENT_ID
    expect(isConnectorConfigured("gdrive")).toBe(false)
    expect(isConnectorConfigured("dropbox")).toBe(true)
  })

  it("Google authorize: scope drive.readonly + access_type=offline + redirect do console", () => {
    const u = new URL(authorizeUrl("gdrive", "st8"))
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(u.searchParams.get("scope")).toContain("drive.readonly")
    expect(u.searchParams.get("access_type")).toBe("offline")
    expect(u.searchParams.get("redirect_uri")).toBe("https://console.x/motor/clipes/oauth/callback")
    expect(u.searchParams.get("state")).toBe("st8")
  })

  it("Dropbox authorize: token_access_type=offline (refresh)", () => {
    const u = new URL(authorizeUrl("dropbox", "s"))
    expect(u.searchParams.get("token_access_type")).toBe("offline")
  })

  it("exchangeCode devolve access+refresh+expira", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 })),
    )
    const t = await exchangeCode("gdrive", "code123")
    expect(t.accessToken).toBe("at")
    expect(t.refreshToken).toBe("rt")
    expect(t.expiresAt).toBeInstanceOf(Date)
  })

  it("refresh mantém o refresh antigo quando o provedor não devolve um novo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "at2", expires_in: 3600 }), { status: 200 })))
    const t = await refresh("dropbox", "old-refresh")
    expect(t.accessToken).toBe("at2")
    expect(t.refreshToken).toBe("old-refresh")
  })
})
