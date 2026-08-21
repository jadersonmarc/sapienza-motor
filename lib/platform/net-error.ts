// Falha de CONEXÃO (rede/DNS/timeout/socket) vs. erro de APLICAÇÃO. O painel de crons
// separa os dois (item 3): o motor é instância única e cai a cada deploy, então uma
// falha de conexão a um serviço externo NÃO é a mesma coisa que a peça ser rejeitada.
const CONN_PATTERNS =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network|timeout|aborted|und_err|other side closed/i

export function isConnError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${(e as { cause?: unknown }).cause ?? ""}` : String(e)
  return CONN_PATTERNS.test(msg)
}

/** Separa uma lista de erros de cron (com `.error` já string) em app vs conexão. */
export function splitCronErrors(errors: { error: string }[]): { appErrors: number; connErrors: number } {
  const connErrors = errors.filter((x) => isConnError(x.error)).length
  return { appErrors: errors.length - connErrors, connErrors }
}
