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
import {
  claimClipSource,
  claimNextClip,
  countRenderingClips,
  getClipProps,
  requeueStaleClipSources,
  setItemVideo,
  setItemVideos,
  setRenderStatus,
} from "@/lib/content/store"
import { getEditorConfig } from "@/lib/content/editor-config"
import { runSourcePipeline } from "@/lib/content/clip-pipeline"
import type { ClipProps } from "@/lib/content/clip-types"
import { contentTransition } from "@/lib/content/transition"
import { uploadObject, isStorageConfigured, publicUrlForKey } from "@/lib/storage/s3"
import { clipVideoKey } from "@/lib/storage/keys"
import { secretMatches } from "@/lib/platform/webhook"
import { clipCompositionId } from "../src/Root"

// Serviço do CLIPPER (Coolify, separado do web app e do motion-worker). Cada tick:
// (1) recoloca fontes presas na fila; (2) reivindica fontes 'queued' (claim atômico
// FOR UPDATE SKIP LOCKED — pronto p/ N réplicas) e roda a esteira ingest→…→gera
// clipes; (3) renderiza os clipes enfileirados (Remotion → R2 → in_review, janela 48h).

const PORT = Number(process.env.PORT ?? 3300)
const CONCURRENCY = Math.max(1, Number(process.env.CLIP_RENDER_CONCURRENCY ?? 2))
const RENDER_TIMEOUT_MS = Math.max(30_000, Number(process.env.CLIP_RENDER_TIMEOUT_MS ?? 600_000))
const STALE_SECONDS = Math.max(300, Number(process.env.CLIP_STALE_SECONDS ?? 1800))
// Teto de clipes renderizando ao mesmo tempo por tenant (fila por tenant, §7) — um
// cliente não monopoliza a capacidade. Coordenado via DB, vale entre réplicas.
const TENANT_MAX_INFLIGHT = Math.max(1, Number(process.env.CLIP_TENANT_MAX_INFLIGHT ?? 3))
const LICENSE_KEY = process.env.REMOTION_LICENSE_KEY ?? "free-license"
const BRAND_HANDLE = process.env.MOTION_BRAND_HANDLE ?? "@sapienzalabs"

let serveUrlPromise: Promise<string> | null = null
function getServeUrl(): Promise<string> {
  if (!serveUrlPromise) {
    serveUrlPromise = bundle({
      entryPoint: join(process.cwd(), "src", "index.ts"),
      publicDir: join(process.cwd(), "public"),
    })
  }
  return serveUrlPromise
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms)),
  ])
}

async function resolveLogo(url: string | null | undefined): Promise<string> {
  const u = (url ?? "").trim()
  if (!/^https:\/\//i.test(u)) return ""
  try {
    const res = await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(5000) })
    return res.ok ? u : ""
  } catch {
    return ""
  }
}

// ── (2) Esteira das fontes ────────────────────────────────────────────────────

async function processSources(sql: ReturnType<typeof getDb>, tenantId: string): Promise<number> {
  let processed = 0
  for (;;) {
    const claimed = await withTenant(sql, tenantId, (tx) => claimClipSource(tx, ["queued"], "downloading"))
    if (!claimed) break
    try {
      const r = await runSourcePipeline(sql, tenantId, claimed.id)
      console.log(`[clip-worker] fonte ${claimed.id}: ${r.clips} clipe(s) gerados`)
    } catch (e) {
      console.error(`[clip-worker] fonte ${claimed.id} falhou:`, e instanceof Error ? e.message : e)
    }
    processed++
  }
  return processed
}

// ── (3) Render dos clipes ─────────────────────────────────────────────────────

type QueuedClip = { id: string; slug: string; clip_aspect: string | null }

async function renderClip(sql: ReturnType<typeof getDb>, tenantId: string, item: QueuedClip): Promise<void> {
  // O clipe já foi reivindicado (render_status='rendering') pelo claim atômico.
  try {
    if (!isStorageConfigured()) throw new Error("storage R2 não configurado (S3_* / MOTOR_PUBLIC_URL)")
    const { props, handle, logoUrl } = await withTenant(sql, tenantId, async (tx) => {
      const cfg = await getEditorConfig(tx)
      return { props: (await getClipProps(tx, item.id)) as ClipProps | null, handle: cfg.handle, logoUrl: cfg.logo_url }
    })
    if (!props) throw new Error("clipe sem clip_props")
    const aspect = props.aspect
    const brandLogo = props.brandOn ? await resolveLogo(logoUrl) : ""
    const sourceUrl = publicUrlForKey(tenantId, props.sourceKey)
    const serveUrl = await getServeUrl()

    const output = join(tmpdir(), `clip-${randomUUID()}.mp4`)
    try {
      const inputProps = { aspect, sourceUrl, brandHandle: handle?.trim() || BRAND_HANDLE, brandLogo, clip: props }
      const composition = await selectComposition({ serveUrl, id: clipCompositionId(aspect), inputProps })
      const opts = {
        composition,
        serveUrl,
        codec: "h264" as const,
        outputLocation: output,
        inputProps,
        licenseKey: LICENSE_KEY,
        imageFormat: "jpeg" as const,
        jpegQuality: 80,
        x264Preset: "faster" as const,
        crf: 23,
        audioCodec: "aac" as const,
      }
      await withTimeout(renderMedia(opts as Parameters<typeof renderMedia>[0]), RENDER_TIMEOUT_MS, `render clip ${item.id}`)
      const buf = await readFile(output)
      const url = await uploadObject(tenantId, clipVideoKey({ slug: item.slug }), buf, "video/mp4")
      await withTenant(sql, tenantId, async (tx) => {
        await setItemVideo(tx, item.id, url)
        await setItemVideos(tx, item.id, { [aspect]: url })
        await setRenderStatus(tx, item.id, "done")
      })
      await contentTransition(sql, tenantId, item.id, "in_review") // janela de 48h
      console.log(`[clip-worker] clipe ${item.id} renderizado (${aspect})`)
    } finally {
      await unlink(output).catch(() => {})
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[clip-worker] falha no clipe ${item.id}:`, msg)
    await withTenant(sql, tenantId, (tx) => setRenderStatus(tx, item.id, "error", msg)).catch(() => {})
  }
}

async function renderQueuedClips(sql: ReturnType<typeof getDb>, tenantId: string): Promise<number> {
  let done = 0
  async function worker() {
    for (;;) {
      // Teto por tenant: não passa de N clipes renderizando ao mesmo tempo (§7).
      const inflight = await withTenant(sql, tenantId, (tx) => countRenderingClips(tx))
      if (inflight >= TENANT_MAX_INFLIGHT) break
      // Claim atômico (queued→rendering): duas réplicas nunca pegam o mesmo clipe.
      const clip = await withTenant(sql, tenantId, (tx) => claimNextClip(tx))
      if (!clip) break
      await renderClip(sql, tenantId, clip as QueuedClip)
      done++
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return done
}

let scanning = false
async function scan(): Promise<{ tenants: number; sources: number; clips: number }> {
  const sql = getDb()
  const tenants = await activeTenants(sql)
  let sources = 0
  let clips = 0
  for (const tenantId of tenants) {
    await withTenant(sql, tenantId, (tx) => requeueStaleClipSources(tx, STALE_SECONDS)).catch(() => 0)
    sources += await processSources(sql, tenantId)
    clips += await renderQueuedClips(sql, tenantId)
  }
  return { tenants: tenants.length, sources, clips }
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
      .then((r) => console.log(`[clip-worker] scan: ${r.sources} fonte(s), ${r.clips} clipe(s) em ${r.tenants} tenant(s)`))
      .catch((e) => console.error("[clip-worker] scan falhou:", e))
      .finally(() => {
        scanning = false
      })
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(PORT, () => {
  console.log(`[clip-worker] ouvindo em :${PORT} (concorrência ${CONCURRENCY}, timeout ${RENDER_TIMEOUT_MS}ms)`)
  getServeUrl().catch((e) => console.error("[clip-worker] warmup do bundle falhou:", e))
})
