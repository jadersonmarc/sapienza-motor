import { spawn } from "node:child_process"
import { readFile, writeFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import type { Sql } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import {
  type ClipSource,
  getClipSource,
  setClipSourceStatus,
  setClipSourceError,
  setClipSourceProbe,
  setClipSourceClips,
  saveTranscript,
  createClipItem,
  addRevision,
  setRenderStatus,
} from "@/lib/content/store"
import { reserveClipHours, refundClipHours } from "@/lib/content/quota"
import { emitUsageRecorded } from "@/lib/platform/events"
import { currentPeriod } from "@/lib/platform/period"
import { sttFromEnv, type SttProvider } from "@/lib/platform/stt"
import { analyzeClips, sliceWords, buildOverlays } from "@/lib/ai/clip-analysis"
import type { ClipProps, ClipAspect, ClipSuggestion, TranscriptWord } from "@/lib/content/clip-types"
import { uploadObject, getObject } from "@/lib/storage/s3"
import { clipRawKey } from "@/lib/storage/keys"
import { slugify } from "@/lib/content/slug"

// Esteira do Clipper: uma fonte (clip_sources) vira lote de clipes. Roda no
// clip-worker, fora do web app. Cada estágio atualiza clip_sources.status (para a
// UI e a retomada). O custo (chamada de modelo, render) é assíncrono; as horas são
// debitadas UMA vez no probe (idempotente por minutes_charged) e estornadas se a
// ingestão falhar. As chamadas a binários externos (yt-dlp/ffmpeg) ficam atrás de
// MediaTools, injetável para teste.

export const MAX_SOURCE_SECONDS = 4 * 3600 // teto por arquivo (§5.2): 4h
export const RAW_RETENTION_DAYS = 7
export const ASSET_RETENTION_DAYS = 60

/** Minutos cobrados de uma duração (arredonda p/ o minuto cheio, mínimo 1). */
export function minutesFor(durationSec: number): number {
  return Math.max(1, Math.ceil(durationSec / 60))
}

/** Normaliza links de compartilhamento de nuvem para download direto (Onda 2, sem
 *  OAuth): Google Drive e Dropbox. Demais URLs (YouTube/Vimeo/etc.) seguem intactas
 *  para o yt-dlp. Não valida — só reescreve o formato conhecido. */
export function normalizeSourceUrl(url: string): string {
  const u = url.trim()
  // Google Drive: .../file/d/<id>/... ou ...open?id=<id> → uc?export=download&id=<id>
  const drive = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?[^#]*id=)([a-zA-Z0-9_-]+)/)
  if (drive) return `https://drive.google.com/uc?export=download&id=${drive[1]}`
  // Dropbox: força o download direto (dl=1).
  if (/dropbox\.com\//i.test(u)) {
    try {
      const parsed = new URL(u)
      parsed.searchParams.set("dl", "1")
      return parsed.toString()
    } catch {
      return u
    }
  }
  return u
}

/** Janelas de expiração a partir de agora (bruto 7d; transcrição/clipes 60d). */
export function retentionDates(now = new Date()): { rawExpiresAt: string; expiresAt: string } {
  const raw = new Date(now.getTime() + RAW_RETENTION_DAYS * 86400_000)
  const full = new Date(now.getTime() + ASSET_RETENTION_DAYS * 86400_000)
  return { rawExpiresAt: raw.toISOString(), expiresAt: full.toISOString() }
}

/** Monta as props de render de um clipe a partir da sugestão da análise + as
 *  palavras da transcrição (absolutas). Pura — o karaokê recebe words já recortados
 *  e re-baseados; o card de abertura usa o gancho. */
export function buildClipProps(s: ClipSuggestion, transcriptWords: TranscriptWord[], sourceKey: string): ClipProps {
  const inMs = Math.round(s.start_time * 1000)
  const outMs = Math.round(s.end_time * 1000)
  const aspect: ClipAspect = s.suggested_aspect_ratio === "16:9" ? "16x9" : "9x16"
  const hook = s.hook_text.trim()
  const words = sliceWords(transcriptWords, inMs, outMs)
  return {
    sourceKey,
    inMs,
    outMs,
    aspect,
    caption: { position: "bottom" },
    words,
    openingCard: hook ? { words: hook.split(/\s+/).slice(0, 8), highlightIndex: 0 } : undefined,
    overlays: buildOverlays(s, words),
    brandOn: true,
    score: s.score,
  }
}

// ── Ferramentas de mídia (binários externos, isoláveis p/ teste) ──────────────

export type ProbeResult = { durationSec: number; sizeBytes: number }

export type MediaTools = {
  /** Baixa a URL para destPath (yt-dlp). */
  downloadUrl(origin: string, destPath: string): Promise<void>
  /** Duração e tamanho via ffprobe. */
  probe(path: string): Promise<ProbeResult>
  /** Extrai só o áudio (mp3) para audioPath (ffmpeg). */
  extractAudio(videoPath: string, audioPath: string): Promise<void>
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (err += d))
    p.on("error", reject)
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} falhou (${code}): ${err.slice(-400)}`))))
  })
}

/** Impl padrão sobre yt-dlp + ffmpeg/ffprobe (presentes na imagem do clip-worker). */
export const defaultMediaTools: MediaTools = {
  async downloadUrl(origin, destPath) {
    // -f mp4 best; --no-playlist p/ não baixar canal inteiro; saída direta no arquivo.
    await run("yt-dlp", ["--no-playlist", "-f", "mp4/bestvideo+bestaudio/best", "-o", destPath, origin])
  },
  async probe(path) {
    const out = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size",
      "-of",
      "json",
      path,
    ])
    const j = JSON.parse(out) as { format?: { duration?: string; size?: string } }
    return {
      durationSec: Math.round(Number(j.format?.duration ?? 0)),
      sizeBytes: Number(j.format?.size ?? 0),
    }
  },
  async extractAudio(videoPath, audioPath) {
    // Só áudio, mono 16kHz mp3 — leve e suficiente p/ Whisper; NÃO envia o vídeo.
    await run("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioPath])
  },
}

export type SourceDeps = {
  media?: MediaTools
  stt?: SttProvider
  model?: string
  now?: () => Date
}

/**
 * Roda a esteira de UMA fonte já reivindicada (status inicial 'downloading') até
 * gerar os clipes. Em falha: marca 'error' e estorna as horas debitadas. Idempotente
 * no débito (só cobra se minutes_charged==0).
 */
export async function runSourcePipeline(
  sql: Sql,
  tenantId: string,
  sourceId: string,
  deps: SourceDeps = {},
): Promise<{ clips: number }> {
  const media = deps.media ?? defaultMediaTools
  const stt = deps.stt ?? sttFromEnv()
  const now = deps.now ?? (() => new Date())

  const source = await withTenant(sql, tenantId, (tx) => getClipSource(tx, sourceId))
  if (!source) throw new Error(`fonte ${sourceId} não encontrada`)

  const tmpVideo = join(tmpdir(), `clip-src-${randomUUID()}.mp4`)
  const tmpAudio = join(tmpdir(), `clip-aud-${randomUUID()}.mp3`)
  let charged = source.minutes_charged

  try {
    // 1) Baixa o vídeo-fonte para um arquivo local.
    const rawKey = source.r2_key_raw ?? clipRawKey({ sourceId, ext: "mp4" })
    if (source.kind === "url") {
      await withTenant(sql, tenantId, (tx) => setClipSourceStatus(tx, sourceId, "downloading"))
      await media.downloadUrl(source.origin, tmpVideo)
      const buf = await readFile(tmpVideo)
      await uploadObject(tenantId, rawKey, buf, "video/mp4")
    } else {
      // upload: a API já subiu o bruto no R2; traz para o disco.
      const obj = await getObject(tenantId, rawKey)
      if (!obj) throw new Error("vídeo-fonte não encontrado no storage")
      await writeFile(tmpVideo, obj.body)
    }

    // 2) Probe: duração/tamanho, valida teto, debita horas (uma vez).
    await withTenant(sql, tenantId, (tx) => setClipSourceStatus(tx, sourceId, "probing"))
    const probe = await media.probe(tmpVideo)
    if (probe.durationSec <= 0) throw new Error("não foi possível ler a duração do vídeo")
    if (probe.durationSec > MAX_SOURCE_SECONDS) {
      throw new Error(`vídeo acima do teto de ${MAX_SOURCE_SECONDS / 3600}h (tem ${(probe.durationSec / 3600).toFixed(1)}h)`)
    }
    const minutes = minutesFor(probe.durationSec)
    const ret = retentionDates(now())
    if (charged === 0) {
      await reserveClipHours(sql, tenantId, minutes) // lança ClipperHoursError se estourar
      charged = minutes
    }
    await withTenant(sql, tenantId, (tx) =>
      setClipSourceProbe(tx, sourceId, {
        durationSeconds: probe.durationSec,
        sizeBytes: probe.sizeBytes,
        minutesCharged: charged,
        rawKey,
        rawExpiresAt: ret.rawExpiresAt,
        expiresAt: ret.expiresAt,
      }),
    )

    // 3) Extrai o áudio e transcreve (com word-timestamps p/ karaokê).
    await withTenant(sql, tenantId, (tx) => setClipSourceStatus(tx, sourceId, "extracting_audio"))
    await media.extractAudio(tmpVideo, tmpAudio)
    if (!stt.configured()) throw new Error("STT não configurado (STT_API_KEY)")
    await withTenant(sql, tenantId, (tx) => setClipSourceStatus(tx, sourceId, "transcribing"))
    const audio = await readFile(tmpAudio)
    const transcript = await stt.transcribe(audio, "audio/mp3", { wordTimestamps: true, language: "pt" })
    if (!transcript.text.trim()) throw new Error("transcrição vazia")
    await withTenant(sql, tenantId, (tx) =>
      saveTranscript(tx, {
        sourceId,
        lang: transcript.lang || null,
        text: transcript.text,
        words: transcript.words,
        expiresAt: ret.expiresAt,
      }),
    )

    // 4) Análise: seleciona os cortes (guardrail source_quote aplicado dentro).
    await withTenant(sql, tenantId, (tx) => setClipSourceStatus(tx, sourceId, "analyzing"))
    const analysis = await analyzeClips(transcript.text, { model: deps.model })
    // Instrumentação de custo por job (etapa 3): tokens da análise, ao lado das horas
    // (clipper_minutos) e do render_ms. clipper_tokens é LIMITE OPERACIONAL/telemetria,
    // NÃO fatura — o fechamento junta só metric='peca'. Não toca close.ts/plans.
    const tokens = analysis.usage.inputTokens + analysis.usage.outputTokens
    console.log(
      `[clip][analyze] source=${sourceId} model=${analysis.model} ` +
        `in_tokens=${analysis.usage.inputTokens} out_tokens=${analysis.usage.outputTokens} clips=${analysis.clips.length}`,
    )
    if (tokens > 0) {
      await withTenant(sql, tenantId, (tx) =>
        emitUsageRecorded(tx, { tenantId, metric: "clipper_tokens", count: tokens, period: currentPeriod() }),
      )
    }

    // 5) Geração: cada corte vira um content_item is_clip com clip_props, enfileirado
    //    para render (nasce 'preparing', vira 'queued' só após gravar as props).
    await withTenant(sql, tenantId, (tx) => setClipSourceStatus(tx, sourceId, "generating"))
    let created = 0
    for (const s of analysis.clips) {
      const props = buildClipProps(s, transcript.words as TranscriptWord[], rawKey)
      const slug = `${slugify(s.title) || "clip"}-${Date.now().toString(36)}-${created}`
      await withTenant(sql, tenantId, async (tx) => {
        const item = await createClipItem(tx, { slug, aspect: props.aspect, sourceId, authorId: source.author_id })
        await addRevision(tx, item.id, {
          title: s.title || "Clipe",
          bodyMarkdown: s.hook_text || s.title || "",
          excerpt: (s.rationale || "").slice(0, 140),
          ai: false,
          authorId: source.author_id,
          clipProps: props as unknown as Record<string, unknown>,
        })
        await setRenderStatus(tx, item.id, "queued") // libera p/ o render (props já gravadas)
      })
      created++
    }
    await withTenant(sql, tenantId, async (tx) => {
      await setClipSourceClips(tx, sourceId, created)
      await setClipSourceStatus(tx, sourceId, "done")
    })
    return { clips: created }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Estorna as horas: o cliente não paga cota por ingestão que não se concretizou.
    if (charged > 0) await refundClipHours(sql, tenantId, charged).catch(() => {})
    await withTenant(sql, tenantId, (tx) => setClipSourceError(tx, sourceId, msg)).catch(() => {})
    throw e
  } finally {
    await unlink(tmpVideo).catch(() => {})
    await unlink(tmpAudio).catch(() => {})
  }
}

// Re-export para o worker montar o inputProps de render sem reimportar tudo.
export type { ClipSource }
