// Cutuca o clip-worker assim que uma fonte entra na fila, em vez de esperar o cron.
// Fire-and-forget: sem URL/secret, ou falha, o cron pega no próximo tick. O /trigger
// é idempotente (guardado por um flag de scanning no worker).
export async function pokeClipWorker(): Promise<void> {
  const url = process.env.CLIP_RENDER_URL
  const secret = process.env.WEBHOOK_SECRET
  if (!url || !secret) return
  try {
    await fetch(`${url.replace(/\/$/, "")}/trigger`, {
      method: "POST",
      headers: { "x-webhook-secret": secret },
      signal: AbortSignal.timeout(5_000),
    })
  } catch (e) {
    console.error("[clip] não consegui cutucar o clip-worker (cron pega depois):", e)
  }
}
