import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { isOAuthConfigured, authorizeUrl, exchangeCode, refresh, oauthProvider } from "./oauth"

// Puros (fetch mockado). Cobrem seam (sem envs), montagem da authorize URL e o
// exchange/refresh de Meta e LinkedIn.

describe("oauth — provider + seam", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.META_APP_ID
    delete process.env.META_APP_SECRET
    delete process.env.LINKEDIN_CLIENT_ID
    delete process.env.LINKEDIN_CLIENT_SECRET
    delete process.env.OAUTH_REDIRECT_BASE
  })

  it("mapeia canal → provedor", () => {
    expect(oauthProvider("instagram")).toBe("meta")
    expect(oauthProvider("facebook")).toBe("meta")
    expect(oauthProvider("linkedin")).toBe("linkedin")
    expect(oauthProvider("blog")).toBeNull()
  })

  it("seam: sem envs, não está configurado", () => {
    expect(isOAuthConfigured("instagram")).toBe(false)
    expect(isOAuthConfigured("linkedin")).toBe(false)
  })

  it("authorizeUrl inclui client_id, redirect, state e os escopos (com insights)", () => {
    process.env.META_APP_ID = "app123"
    process.env.META_APP_SECRET = "sec"
    process.env.OAUTH_REDIRECT_BASE = "https://console.x.com"
    expect(isOAuthConfigured("instagram")).toBe(true)
    const url = new URL(authorizeUrl("instagram", "st8"))
    expect(url.origin + url.pathname).toContain("facebook.com")
    expect(url.searchParams.get("client_id")).toBe("app123")
    expect(url.searchParams.get("redirect_uri")).toBe("https://console.x.com/motor/canais/oauth/callback")
    expect(url.searchParams.get("state")).toBe("st8")
    expect(url.searchParams.get("scope")).toContain("instagram_manage_insights")
    expect(url.searchParams.get("scope")).toContain("instagram_content_publish")
  })
})

describe("oauth — exchange/refresh", () => {
  beforeEach(() => {
    process.env.META_APP_ID = "app123"
    process.env.META_APP_SECRET = "sec"
    process.env.LINKEDIN_CLIENT_ID = "li123"
    process.env.LINKEDIN_CLIENT_SECRET = "lisec"
    process.env.OAUTH_REDIRECT_BASE = "https://console.x.com"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.META_APP_ID
    delete process.env.META_APP_SECRET
    delete process.env.LINKEDIN_CLIENT_ID
    delete process.env.LINKEDIN_CLIENT_SECRET
    delete process.env.OAUTH_REDIRECT_BASE
  })

  it("Meta/Instagram: code → user token longo → page token + account_id", async () => {
    const fetchMock = vi.fn(async (u: string) => {
      const url = String(u)
      if (url.includes("/oauth/access_token") && url.includes("fb_exchange_token"))
        return new Response(JSON.stringify({ access_token: "USERLONG", expires_in: 5184000 }), { status: 200 })
      if (url.includes("/oauth/access_token"))
        return new Response(JSON.stringify({ access_token: "SHORT" }), { status: 200 })
      if (url.includes("/me/accounts"))
        return new Response(JSON.stringify({ data: [{ id: "PAGE1", access_token: "PAGETOKEN" }] }), { status: 200 })
      if (url.includes("/PAGE1"))
        return new Response(JSON.stringify({ instagram_business_account: { id: "IG777" } }), { status: 200 })
      return new Response("{}", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const t = await exchangeCode("instagram", "CODE")
    expect(JSON.parse(t.credentials)).toEqual({ access_token: "PAGETOKEN", account_id: "IG777" })
    expect(t.refreshToken).toBe("USERLONG") // material de refresh = user token longo
    expect(t.expiresAt).toBeInstanceOf(Date)
  })

  it("Meta/Facebook: exchange devolve page token + page_id", async () => {
    const fetchMock = vi.fn(async (u: string) => {
      const url = String(u)
      if (url.includes("fb_exchange_token")) return new Response(JSON.stringify({ access_token: "USERLONG" }), { status: 200 })
      if (url.includes("/oauth/access_token")) return new Response(JSON.stringify({ access_token: "SHORT" }), { status: 200 })
      if (url.includes("/me/accounts")) return new Response(JSON.stringify({ data: [{ id: "PG9", access_token: "PGTOK" }] }), { status: 200 })
      return new Response("{}", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const t = await exchangeCode("facebook", "CODE")
    expect(JSON.parse(t.credentials)).toEqual({ access_token: "PGTOK", page_id: "PG9" })
  })

  it("LinkedIn: code → access_token (+ refresh) e refresh usa grant_type=refresh_token", async () => {
    const fetchMock = vi.fn(async (_u: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ access_token: "LIACC", expires_in: 5184000, refresh_token: "LIREFRESH" }), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const t = await exchangeCode("linkedin", "CODE")
    expect(JSON.parse(t.credentials)).toEqual({ access_token: "LIACC" })
    expect(t.refreshToken).toBe("LIREFRESH")

    const r = await refresh("linkedin", "LIREFRESH")
    expect(JSON.parse(r.credentials)).toEqual({ access_token: "LIACC" })
    const body = (fetchMock.mock.calls.at(-1)![1] as RequestInit).body as URLSearchParams
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("refresh_token")).toBe("LIREFRESH")
  })
})
