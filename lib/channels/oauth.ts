import type { Platform } from "./types"

// OAuth + refresh de token por canal. A ideia: o cliente conecta uma vez e a
// Sapienza passa a renovar o token sozinha. SEAM: sem as envs do app do provedor,
// isOAuthConfigured=false → o console cai no colar-JSON manual (nada muda).
//
// `credentials` é o MESMO blob JSON que os adapters (impls.ts) já leem:
//   instagram {access_token(page token), account_id}
//   facebook  {access_token(page token), page_id}
//   linkedin  {access_token}   (o author é resolvido pelo token no publish)
// `refreshToken` guarda o material de renovação: no Meta é o USER token de longa
// duração (com ele re-derivamos o page token); no LinkedIn é o refresh_token.

export type OAuthProvider = "meta" | "linkedin"
export type OAuthToken = { credentials: string; expiresAt: Date | null; refreshToken: string | null }

/** Canais que suportam OAuth (os demais seguem só no colar-JSON/sem token). */
export function oauthProvider(platform: Platform): OAuthProvider | null {
  if (platform === "instagram" || platform === "facebook") return "meta"
  if (platform === "linkedin") return "linkedin"
  return null
}

const META_GRAPH = "https://graph.facebook.com/v21.0"
const META_DIALOG = "https://www.facebook.com/v21.0/dialog/oauth"
const LI_AUTH = "https://www.linkedin.com/oauth/v2/authorization"
const LI_TOKEN = "https://www.linkedin.com/oauth/v2/accessToken"

// Escopos (publicação + métricas) — espelham a guia (Fase 1).
const SCOPES: Record<Platform, string[]> = {
  instagram: ["instagram_basic", "instagram_content_publish", "instagram_manage_insights", "pages_show_list", "pages_read_engagement"],
  facebook: ["pages_manage_posts", "pages_read_engagement", "pages_show_list", "read_insights"],
  linkedin: ["w_member_social", "openid", "profile"],
  blog: [],
  wordpress: [],
  webhook: [],
  twitter: [],
  threads: [],
}

type ProviderCfg = { clientId: string; clientSecret: string }
function providerCfg(provider: OAuthProvider): ProviderCfg | null {
  const e = process.env
  if (provider === "meta") {
    return e.META_APP_ID && e.META_APP_SECRET ? { clientId: e.META_APP_ID, clientSecret: e.META_APP_SECRET } : null
  }
  return e.LINKEDIN_CLIENT_ID && e.LINKEDIN_CLIENT_SECRET
    ? { clientId: e.LINKEDIN_CLIENT_ID, clientSecret: e.LINKEDIN_CLIENT_SECRET }
    : null
}

/** URI de callback registrado no app OAuth (fixo, no console). */
export function redirectUri(): string {
  const base = (process.env.OAUTH_REDIRECT_BASE ?? "").replace(/\/$/, "")
  return base ? `${base}/motor/canais/oauth/callback` : ""
}

/** true se dá para fazer OAuth deste canal (app configurado + redirect definido). */
export function isOAuthConfigured(platform: Platform): boolean {
  const p = oauthProvider(platform)
  return !!p && !!providerCfg(p) && !!redirectUri()
}

/** URL de autorização do provedor (o console redireciona o usuário para cá). */
export function authorizeUrl(platform: Platform, state: string): string {
  const provider = oauthProvider(platform)
  if (!provider) throw new Error(`canal sem OAuth: ${platform}`)
  const cfg = providerCfg(provider)
  if (!cfg) throw new Error("OAuth não configurado")
  const scope = SCOPES[platform].join(provider === "meta" ? "," : " ")
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    scope,
    state,
  })
  return `${provider === "meta" ? META_DIALOG : LI_AUTH}?${params.toString()}`
}

const secs = (n: number | undefined): Date | null => (n && n > 0 ? new Date(Date.now() + n * 1000) : null)

// ── Meta (Instagram + Facebook) ───────────────────────────────────────────────

async function metaGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${META_GRAPH}/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`meta ${path}: ${res.status} ${await res.text().catch(() => "")}`)
  return (await res.json()) as T
}

// Troca o user token de longa duração pelo par (page token + página/IG) e monta as
// credenciais do canal. Reusado no exchange e no refresh.
async function metaCredentialsFromUserToken(platform: Platform, userToken: string): Promise<string> {
  const accounts = await metaGet<{ data?: { id: string; access_token: string }[] }>("me/accounts", { access_token: userToken })
  const page = accounts.data?.[0]
  if (!page) throw new Error("meta: nenhuma Página encontrada para este token")
  if (platform === "facebook") {
    return JSON.stringify({ access_token: page.access_token, page_id: page.id })
  }
  const ig = await metaGet<{ instagram_business_account?: { id: string } }>(page.id, {
    fields: "instagram_business_account",
    access_token: page.access_token,
  })
  const accountId = ig.instagram_business_account?.id
  if (!accountId) throw new Error("meta: a Página não tem conta Instagram Business vinculada")
  return JSON.stringify({ access_token: page.access_token, account_id: accountId })
}

// code → short-lived → long-lived user token (~60d).
async function metaLongLivedUserToken(cfg: ProviderCfg, code?: string, exchangeToken?: string): Promise<{ token: string; expiresAt: Date | null }> {
  const base = { client_id: cfg.clientId, client_secret: cfg.clientSecret }
  let userToken: string
  if (code) {
    const short = await metaGet<{ access_token: string }>("oauth/access_token", { ...base, redirect_uri: redirectUri(), code })
    userToken = short.access_token
  } else {
    userToken = exchangeToken!
  }
  const long = await metaGet<{ access_token: string; expires_in?: number }>("oauth/access_token", {
    ...base,
    grant_type: "fb_exchange_token",
    fb_exchange_token: userToken,
  })
  return { token: long.access_token, expiresAt: secs(long.expires_in ?? 5184000) }
}

// ── LinkedIn ──────────────────────────────────────────────────────────────────

async function liToken(cfg: ProviderCfg, body: Record<string, string>): Promise<{ access_token: string; expires_in?: number; refresh_token?: string }> {
  const res = await fetch(LI_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`linkedin token: ${res.status} ${await res.text().catch(() => "")}`)
  return (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string }
}

// ── API pública: exchange (callback) + refresh (cron/borda) ───────────────────

/** Troca o `code` do callback por credenciais prontas do canal. */
export async function exchangeCode(platform: Platform, code: string): Promise<OAuthToken> {
  const provider = oauthProvider(platform)
  const cfg = provider && providerCfg(provider)
  if (!provider || !cfg) throw new Error("OAuth não configurado")
  if (provider === "meta") {
    const user = await metaLongLivedUserToken(cfg, code)
    const credentials = await metaCredentialsFromUserToken(platform, user.token)
    // O USER token de longa duração é o material de refresh (re-deriva o page token).
    return { credentials, expiresAt: user.expiresAt, refreshToken: user.token }
  }
  const t = await liToken(cfg, { grant_type: "authorization_code", code, redirect_uri: redirectUri() })
  return { credentials: JSON.stringify({ access_token: t.access_token }), expiresAt: secs(t.expires_in), refreshToken: t.refresh_token ?? null }
}

/** Renova o token a partir do material guardado (Meta: user token; LinkedIn: refresh_token). */
export async function refresh(platform: Platform, refreshToken: string): Promise<OAuthToken> {
  const provider = oauthProvider(platform)
  const cfg = provider && providerCfg(provider)
  if (!provider || !cfg) throw new Error("OAuth não configurado")
  if (provider === "meta") {
    const user = await metaLongLivedUserToken(cfg, undefined, refreshToken)
    const credentials = await metaCredentialsFromUserToken(platform, user.token)
    return { credentials, expiresAt: user.expiresAt, refreshToken: user.token }
  }
  const t = await liToken(cfg, { grant_type: "refresh_token", refresh_token: refreshToken })
  return { credentials: JSON.stringify({ access_token: t.access_token }), expiresAt: secs(t.expires_in), refreshToken: t.refresh_token ?? refreshToken }
}
