import http from "node:http"
import { spawn } from "node:child_process"
import { readFile, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { bundle } from "@remotion/bundler"
import { selectComposition, renderMedia } from "@remotion/renderer"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { activeTenants } from "@/lib/platform/gating"
import { listQueuedMotion, getMotionProps, setItemVideo, setItemVideos, setRenderStatus } from "@/lib/content/store"
import { getEditorConfig } from "@/lib/content/editor-config"
import { trackFor } from "@/lib/content/motion-audio"
import { fanoutAspects, type MotionAspect, type StoryProps } from "@/lib/content/motion-types"
import { scrimForPreset } from "@/lib/content/motion-image"
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
    // publicDir explícito: garante que o bundle sirva public/fonts (e public/audio)
    // via staticFile no ambiente de render — sem isso o load de fonte pode pendurar.
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

// Valida o logo do tenant: só passa adiante se for https e responder OK a um HEAD
// rápido. Qualquer falha → "" (o rodapé usa o monograma). Nunca lança.
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

// Luminância média (0..1) da imagem via ffmpeg (downscale 1×1 → 1 pixel RGB). Robusto
// (decodifica jpg/png/webp). Falha/timeout → 0.5 (neutro → scrim fica no piso). O
// bundle do @remotion/renderer traz o ffmpeg; a imagem tem ffmpeg CLI no Dockerfile.
async function imageLuminance(url: string): Promise<number> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return 0.5
    const bytes = Buffer.from(await res.arrayBuffer())
    const rgb = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn("ffmpeg", ["-i", "pipe:0", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
        stdio: ["pipe", "pipe", "ignore"],
      })
      const chunks: Buffer[] = []
      const timer = setTimeout(() => {
        p.kill("SIGKILL")
        reject(new Error("ffmpeg timeout"))
      }, 8000)
      p.stdout.on("data", (d) => chunks.push(d))
      p.on("error", (e) => {
        clearTimeout(timer)
        reject(e)
      })
      p.on("close", () => {
        clearTimeout(timer)
        resolve(Buffer.concat(chunks))
      })
      p.stdin.on("error", () => {}) // EPIPE se o ffmpeg fechar antes
      p.stdin.end(bytes)
    })
    if (rgb.length < 3) return 0.5
    return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  } catch {
    return 0.5
  }
}


type QueuedRow = { id: string; slug: string; motion_preset: string | null; motion_aspect: string | null }

async function renderOne(sql: ReturnType<typeof getDb>, tenantId: string, item: QueuedRow): Promise<void> {
  await withTenant(sql, tenantId, (tx) => setRenderStatus(tx, item.id, "rendering"))
  try {
    if (!isStorageConfigured()) throw new Error("storage R2 não configurado (S3_* / MOTOR_PUBLIC_URL)")
    const preset = item.motion_preset
    const aspect = item.motion_aspect as MotionAspect | null
    const { data, handle, logoUrl, imageUrlDb } = await withTenant(sql, tenantId, async (tx) => {
      const cfg = await getEditorConfig(tx)
      const rows = (await tx`SELECT motion_image_url FROM content_items WHERE id = ${item.id}`) as unknown as {
        motion_image_url: string | null
      }[]
      return {
        data: await getMotionProps(tx, item.id),
        handle: cfg.handle,
        logoUrl: cfg.logo_url,
        imageUrlDb: rows[0]?.motion_image_url ?? null,
      }
    })
    if (!preset || !aspect || !data) throw new Error("peça de motion sem preset/aspect/props")

    // Logo do tenant (seam robusto): só usamos se for https E estiver acessível —
    // logo quebrado jamais pode derrubar o render do vídeo do cliente. Falha → vazio
    // (o rodapé cai no monograma da inicial do handle).
    const brandLogo = await resolveLogo(logoUrl)

    // Imagem de fundo (item 7): mesma robustez. Se a URL não resolver (objeto sumiu,
    // R2 fora), renderiza SEM imagem — a peça sai como hoje, que é válido. Scrim é
    // adaptativo por luminância (imagem clara → scrim mais forte).
    let image: { url: string; scrimOpacity: number } | null = null
    if (imageUrlDb) {
      const resolved = await resolveLogo(imageUrlDb)
      if (!resolved) {
        console.warn(`[motion-worker] imagem da peça ${item.id} não resolveu — renderizando sem imagem`)
      } else {
        const lum = await imageLuminance(resolved)
        image = { url: resolved, scrimOpacity: scrimForPreset(preset, lum) }
      }
    }

    // Trilha (seam): só toca se a faixa do mood existir em public/audio. Sem o
    // arquivo, rebaixa para mudo — o vídeo sai como sempre saiu.
    let hasAudio = false
    if (data.kind === "story") {
      const story = data as StoryProps
      const track = trackFor(story.audio ?? "none")
      hasAudio = !!track && existsSync(join(process.cwd(), "public", "audio", track.file))
      if (!hasAudio) story.audio = "none"
    }

    const serveUrl = await getServeUrl()

    // Renderiza UM formato (aspecto) → sobe no R2 e devolve a URL. Chave já é por
    // aspecto (motionVideoKey), sem colisão.
    const renderAspect = async (a: MotionAspect): Promise<string> => {
      const output = join(tmpdir(), `motion-${randomUUID()}.mp4`)
      try {
        const inputProps = { aspect: a, brandHandle: handle?.trim() || BRAND_HANDLE, brandLogo, image, data }
        const composition = await selectComposition({ serveUrl, id: compositionId(preset, a), inputProps })
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
          ...(hasAudio ? { audioCodec: "aac" as const } : {}),
        }
        await withTimeout(renderMedia(opts as Parameters<typeof renderMedia>[0]), TIMEOUT_MS, `render ${a}`)
        const buf = await readFile(output)
        return await uploadObject(tenantId, motionVideoKey({ slug: item.slug, aspect: a }), buf, "video/mp4")
      } finally {
        await unlink(output).catch(() => {})
      }
    }

    // Fan-out: principal (obrigatório) + formatos extras (best-effort — falha num
    // extra não derruba a peça; o principal é o que publica).
    const aspects = fanoutAspects(aspect)
    const urls: Record<string, string> = {}
    urls[aspect] = await renderAspect(aspect) // principal: erro aqui → peça em 'error'
    for (const a of aspects.slice(1)) {
      try {
        urls[a] = await renderAspect(a)
      } catch (e) {
        console.error(`[motion-worker] formato extra ${a} falhou (peça ${item.id}):`, e instanceof Error ? e.message : e)
      }
    }

    await withTenant(sql, tenantId, async (tx) => {
      await setItemVideo(tx, item.id, urls[aspect])
      await setItemVideos(tx, item.id, urls)
      await setRenderStatus(tx, item.id, "done")
    })
    // Render pronto → entra na janela de aprovação de 48h (silêncio = aprovado).
    await contentTransition(sql, tenantId, item.id, "in_review")
    console.log(`[motion-worker] ok: peça ${item.id} (${preset}) → ${Object.keys(urls).join(", ")}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[motion-worker] falha na peça ${item.id}:`, msg)
    await withTenant(sql, tenantId, (tx) => setRenderStatus(tx, item.id, "error", msg)).catch(() => {})
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

server.listen(PORT, () => {
  console.log(`[motion-worker] ouvindo em :${PORT} (concorrência ${CONCURRENCY}, timeout ${TIMEOUT_MS}ms)`)
  // Pré-aquece o bundle do Remotion no boot para o 1º render não pagar o custo
  // de bundling (~dezenas de s). Falha aqui não derruba o worker.
  getServeUrl().catch((e) => console.error("[motion-worker] warmup do bundle falhou:", e))
})
