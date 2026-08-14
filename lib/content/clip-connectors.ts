// Conectores de nuvem do Clipper (Onda 2): OAuth + download autenticado do arquivo
// de vídeo. O cliente conecta a conta uma vez; a Sapienza guarda o token cifrado e
// renova sozinha (mesma ideia do OAuth de canais). SEAM: sem as envs do app do
// provedor, isConnectorConfigured=false → o console mostra só o import por link.

export type CloudProvider = "gdrive" | "dropbox"
export type ConnectorToken = { accessToken: string; refreshToken: string | null; expiresAt: Date | null }

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
const DROPBOX_AUTH = "https://www.dropbox.com/oauth2/authorize"
const DROPBOX_TOKEN = "https://api.dropboxapi.com/oauth2/token"

const SCOPES: Record<CloudProvider, string> = {
  gdrive: "https://www.googleapis.com/auth/drive.readonly",
  dropbox: "files.content.read",
}

type ProviderCfg = { clientId: string; clientSecret: string }

function providerCfg(p: CloudProvider): ProviderCfg | null {
  const e = process.env
  if (p === "gdrive") {
    return e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
      ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET }
      : null
  }
  return e.DROPBOX_APP_KEY && e.DROPBOX_APP_SECRET
    ? { clientId: e.DROPBOX_APP_KEY, clientSecret: e.DROPBOX_APP_SECRET }
    : null
}

/** URI de callback registrado no app OAuth (fixo, no console). */
export function redirectUri(): string {
  const base = (process.env.OAUTH_REDIRECT_BASE ?? "").replace(/\/$/, "")
  return base ? `${base}/motor/clipes/oauth/callback` : ""
}

export function isConnectorConfigured(p: CloudProvider): boolean {
  return !!providerCfg(p) && !!redirectUri()
}

const secs = (n: number | undefined): Date | null => (n && n > 0 ? new Date(Date.now() + n * 1000) : null)

/** URL de autorização do provedor (o console redireciona o usuário para cá). */
export function authorizeUrl(p: CloudProvider, state: string): string {
  const cfg = providerCfg(p)
  if (!cfg) throw new Error("conector não configurado")
  if (p === "gdrive") {
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPES.gdrive,
      access_type: "offline", // devolve refresh_token
      prompt: "consent",
      state,
    })
    return `${GOOGLE_AUTH}?${params.toString()}`
  }
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    token_access_type: "offline", // devolve refresh_token
    scope: SCOPES.dropbox,
    state,
  })
  return `${DROPBOX_AUTH}?${params.toString()}`
}

async function postToken(url: string, body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text().catch(() => "")}`)
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }
}

/** Troca o `code` do callback pelo token (com refresh, quando o provedor devolve). */
export async function exchangeCode(p: CloudProvider, code: string): Promise<ConnectorToken> {
  const cfg = providerCfg(p)
  if (!cfg) throw new Error("conector não configurado")
  const t = await postToken(p === "gdrive" ? GOOGLE_TOKEN : DROPBOX_TOKEN, {
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri(),
  })
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: secs(t.expires_in) }
}

/** Renova o access token a partir do refresh guardado. */
export async function refresh(p: CloudProvider, refreshToken: string): Promise<ConnectorToken> {
  const cfg = providerCfg(p)
  if (!cfg) throw new Error("conector não configurado")
  const t = await postToken(p === "gdrive" ? GOOGLE_TOKEN : DROPBOX_TOKEN, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  })
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? refreshToken, expiresAt: secs(t.expires_in) }
}

/** Baixa o arquivo (bytes) do provedor com o access token. fileRef = id (Drive) ou
 *  path/id (Dropbox). Guard de tamanho fica no chamador. */
export async function downloadFile(p: CloudProvider, accessToken: string, fileRef: string): Promise<Buffer> {
  let res: Response
  if (p === "gdrive") {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileRef)}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(600000),
    })
  } else {
    res = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path: fileRef }),
      },
      signal: AbortSignal.timeout(600000),
    })
  }
  if (!res.ok) throw new Error(`download ${p} ${res.status}: ${await res.text().catch(() => "")}`)
  return Buffer.from(await res.arrayBuffer())
}
