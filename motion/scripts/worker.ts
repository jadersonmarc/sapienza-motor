import http from "node:http"
import { readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { bundle } from "@remotion/bundler"
import { selectComposition, renderMedia } from "@remotion/renderer"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { activeTenants } from "@/lib/platform/gating"
import { listQueuedMotion, getMotionProps, setItemVideo, setRenderStatus } from "@/lib/content/store"
import { contentTransition } from "@/lib/content/transition"
import { uploadObject, isStorageConfigured } from "@/lib/storage/s3"
import { motionVideoKey } from "@/lib/storage/keys"
import { secretMatches } from "@/lib/platform/webhook"
import { compositionId } from "../src/Root"

// Serviço de render de MOTION (Coolify, separado do web app). Acionado por
// cron-scan (POST /trigger, x-webhook-secret) — espelha o publish-scheduled. Cada
// tick: varre os tenants ativos, pega peças com render_status='queued', renderiza o
// MP4 (Remotion local), sobe no R2 e escreve video_url + render_status; ao concluir,
// transiciona a peça para in_review (inicia a janela de 48h). Falha → 'error'.

const PORT = Number(process.env.PORT ?? 3200)
const CONCURRENCY = Math.max(1, Number(process.env.MOTION_RENDER_CONCURRENCY ?? 1))
const TIMEOUT_MS = Math.max(10_000, Number(process.env.MOTION_RENDER_TIMEOUT_MS ?? 120_000))
const LICENSE_KEY = process.env.REMOTION_LICENSE_KEY ?? "free-license"
const BRAND_HANDLE = process.env.MOTION_BRAND_HANDLE ?? "@sapienzalabs" // TODO: handle por-tenant

let serveUrlPromise: Promise<string> | null = null
function getServeUrl(): Promise<string> {
  if (!serveUrlPromise) {
    serveUrlPromise = bundle({ entryPoint: join(process.cwd(), "src", "index.ts") })
  }
  return serveUrlPromise
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms)),
  ])
}

type QueuedRow = { id: string; slug: string; motion_preset: string | null; motion_aspect: string | null }

async function renderOne(sql: ReturnType<typeof getDb>, tenantId: string, item: QueuedRow): Promise<void> {
  await withTenant(sql, tenantId, (tx) => setRenderStatus(tx, item.id, "rendering"))
  const output = join(tmpdir(), `motion-${randomUUID()}.mp4`)
  try {
    if (!isStorageConfigured()) throw new Error("storage R2 não configurado (S3_* / MOTOR_PUBLIC_URL)")
    const preset = item.motion_preset
    const aspect = item.motion_aspect
    const data = await withTenant(sql, tenantId, (tx) => getMotionProps(tx, item.id))
    if (!preset || !aspect || !data) throw new Error("peça de motion sem preset/aspect/props")

    const serveUrl = await getServeUrl()
    const inputProps = { aspect, brandHandle: BRAND_HANDLE, data }
    const composition = await selectComposition({ serveUrl, id: compositionId(preset, aspect), inputProps })
    const opts = { composition, serveUrl, codec: "h264" as const, outputLocation: output, inputProps, licenseKey: LICENSE_KEY }
    await withTimeout(renderMedia(opts as Parameters<typeof renderMedia>[0]), TIMEOUT_MS, "render")

    const buf = await readFile(output)
    const url = await uploadObject(tenantId, motionVideoKey({ slug: item.slug, aspect }), buf, "video/mp4")

    await withTenant(sql, tenantId, async (tx) => {
      await setItemVideo(tx, item.id, url)
      await setRenderStatus(tx, item.id, "done")
    })
    // Render pronto → entra na janela de aprovação de 48h (silêncio = aprovado).
    await contentTransition(sql, tenantId, item.id, "in_review")
    console.log(`[motion-worker] ok: peça ${item.id} (${preset}/${aspect}) → ${url}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[motion-worker] falha na peça ${item.id}:`, msg)
    await withTenant(sql, tenantId, (tx) => setRenderStatus(tx, item.id, "error", msg)).catch(() => {})
  } finally {
    await unlink(output).catch(() => {})
  }
}

/** Processa uma lista com no máximo CONCURRENCY renders simultâneos. */
async function runPool(sql: ReturnType<typeof getDb>, tenantId: string, items: QueuedRow[]): Promise<number> {
  let i = 0
  let done = 0
  async function worker() {
    while (i < items.length) {
      const item = items[i++]
      await renderOne(sql, tenantId, item)
      done++
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  return done
}

let scanning = false
async function scan(): Promise<{ tenants: number; rendered: number }> {
  const sql = getDb()
  const tenants = await activeTenants(sql)
  let rendered = 0
  for (const tenantId of tenants) {
    const queued = (await withTenant(sql, tenantId, (tx) => listQueuedMotion(tx))) as QueuedRow[]
    if (queued.length) rendered += await runPool(sql, tenantId, queued)
  }
  return { tenants: tenants.length, rendered }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, busy: scanning }))
    return
  }
  if (req.method === "POST" && req.url === "/trigger") {
    if (!secretMatches(req.headers["x-webhook-secret"] as string | undefined, process.env.WEBHOOK_SECRET ?? "")) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "unauthorized" }))
      return
    }
    if (scanning) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ started: false, busy: true }))
      return
    }
    scanning = true
    res.writeHead(202, { "content-type": "application/json" })
    res.end(JSON.stringify({ started: true }))
    scan()
      .then((r) => console.log(`[motion-worker] scan: ${r.rendered} render(s) em ${r.tenants} tenant(s)`))
      .catch((e) => console.error("[motion-worker] scan falhou:", e))
      .finally(() => {
        scanning = false
      })
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(PORT, () => console.log(`[motion-worker] ouvindo em :${PORT} (concorrência ${CONCURRENCY}, timeout ${TIMEOUT_MS}ms)`))
