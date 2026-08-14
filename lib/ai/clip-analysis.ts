import { callStructured } from "./client"
import type { ClipOverlay, ClipSuggestion, TranscriptWord } from "@/lib/content/clip-types"

// Seleção de cortes (SPEC §9): o modelo lê a transcrição e devolve os melhores
// momentos, ranqueados. A pontuação é ordenação RELATIVA dentro do vídeo, não
// previsão de desempenho (a UI rotula como "melhores momentos deste vídeo").
//
// GUARDRAIL: source_quote precisa bater como substring literal da transcrição —
// senão o corte é descartado (a IA não inventa momento). Mesmo padrão binário do
// statSourceInBrief do motion. Os tempos por palavra NÃO são pedidos ao modelo:
// vêm da transcrição persistida (sliceWords), evitando inflar a saída e erro de
// alinhamento.

// Sonnet corrente para a seleção (raciocínio sobre transcrição longa). Títulos/
// hashtags ficam no Haiku, na etapa de metadados por canal (social.ts).
export const CLIP_ANALYSIS_MODEL = "claude-sonnet-5"

const CLIP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          clip_id: { type: "string" },
          title: { type: "string" },
          hook_text: { type: "string" },
          source_quote: { type: "string", description: "trecho EXATO e literal da transcrição" },
          start_time: { type: "number", description: "segundos" },
          end_time: { type: "number", description: "segundos" },
          score: { type: "number", description: "0-100, ordenação relativa" },
          rationale: { type: "string" },
          suggested_aspect_ratio: { type: "string", enum: ["9:16", "16:9"] },
        },
        required: [
          "clip_id",
          "title",
          "hook_text",
          "source_quote",
          "start_time",
          "end_time",
          "score",
          "rationale",
          "suggested_aspect_ratio",
        ],
      },
    },
  },
  required: ["clips"],
}

function normalize(s: string): string {
  return s.toLowerCase().trim()
}

/** O source_quote é substring literal da transcrição? (binário, não semântico) */
export function sourceQuoteInTranscript(sourceQuote: string, transcript: string): boolean {
  const q = normalize(sourceQuote)
  if (!q) return false
  return normalize(transcript).includes(q)
}

/** Valida e ordena os cortes crus do modelo contra a transcrição. Descarta os que
 *  falham o guardrail (source_quote não literal) ou têm janela inválida; aplica o
 *  teto de duração da onda; ordena por score desc. Pura — testável sem IA. */
export function validateClips(
  raw: { clips?: Partial<ClipSuggestion>[] },
  transcript: string,
  opts: { maxDurationSec?: number } = {},
): ClipSuggestion[] {
  const maxDur = opts.maxDurationSec ?? 300 // Onda 1: cortes até 5 min
  const out: ClipSuggestion[] = []
  for (const c of raw.clips ?? []) {
    if (
      typeof c.start_time !== "number" ||
      typeof c.end_time !== "number" ||
      typeof c.source_quote !== "string" ||
      c.end_time <= c.start_time
    ) {
      continue
    }
    if (c.end_time - c.start_time > maxDur) continue
    if (!sourceQuoteInTranscript(c.source_quote, transcript)) continue
    const ar = c.suggested_aspect_ratio === "16:9" ? "16:9" : "9:16"
    out.push({
      clip_id: String(c.clip_id ?? `clip_${out.length + 1}`),
      title: String(c.title ?? "").trim(),
      hook_text: String(c.hook_text ?? "").trim(),
      source_quote: c.source_quote,
      start_time: c.start_time,
      end_time: c.end_time,
      score: Math.max(0, Math.min(100, Math.round(Number(c.score ?? 0)))),
      rationale: String(c.rationale ?? "").trim(),
      suggested_aspect_ratio: ar,
    })
  }
  return out.sort((a, b) => b.score - a.score)
}

/** Corrige um termo em todas as ocorrências (STT erra nome próprio/sigla/jargão).
 *  Match do NÚCLEO alfanumérico, case-insensitive, preservando a pontuação ao redor
 *  ("Sapiensa," → "Sapienza,"). Pura — devolve as palavras novas e quantas mudaram. */
export function applyWordCorrection<T extends { text: string }>(
  words: T[],
  from: string,
  to: string,
): { words: T[]; count: number } {
  const core = (s: string) => s.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
  const target = core(from)
  if (!target) return { words, count: 0 }
  let count = 0
  const out = words.map((w) => {
    if (core(w.text) !== target) return w
    count++
    const lead = w.text.match(/^[^\p{L}\p{N}]*/u)?.[0] ?? ""
    const trail = w.text.match(/[^\p{L}\p{N}]*$/u)?.[0] ?? ""
    return { ...w, text: lead + to + trail }
  })
  return { words: out, count }
}

/** Gera overlays (Onda 2) a partir do gancho e das palavras JÁ recortadas do clipe
 *  (re-baseadas a 0). O guardrail é satisfeito POR CONSTRUÇÃO: a citação vem do
 *  source_quote (literal da transcrição) e o `source` do card de dado é montado de
 *  palavras reais do trecho. Determinístico (sem IA), portanto testável.
 *  - Citação: se o source_quote é curto (≤12 palavras), aparece nos ~3s iniciais.
 *  - Card de dado: o 1º número do trecho vira um stat, com contexto literal em `source`. */
export function buildOverlays(suggestion: ClipSuggestion, clipWords: TranscriptWord[]): ClipOverlay[] {
  const overlays: ClipOverlay[] = []

  const quote = suggestion.source_quote.trim()
  if (quote && quote.split(/\s+/).length <= 12) {
    overlays.push({ kind: "quote", startMs: 300, endMs: 3300, quote })
  }

  // 1º token numérico do trecho → card de dado.
  const numRe = /^[^\p{L}\p{N}]*(\d[\d.,]*)\s*(%|k|mil|x)?[^\p{L}\p{N}]*$/iu
  for (let i = 0; i < clipWords.length; i++) {
    const m = clipWords[i].text.match(numRe)
    if (!m) continue
    const value = parseFloat(m[1].replace(/\.(?=\d{3}\b)/g, "").replace(",", "."))
    if (!isFinite(value)) continue
    const suffix = m[2] ?? ""
    const ctx = clipWords.slice(Math.max(0, i - 3), i + 1)
    const label = ctx
      .slice(0, -1)
      .map((w) => w.text)
      .join(" ")
      .slice(0, 40)
    const source = ctx.map((w) => w.text).join(" ")
    overlays.push({
      kind: "stat",
      startMs: clipWords[i].startMs,
      endMs: clipWords[i].startMs + 2500,
      label: label || "Destaque",
      value,
      suffix,
      source,
    })
    break // só o primeiro, para não poluir
  }

  return overlays
}

/** Recorta as palavras do trecho [startMs,outMs] e as re-baseia a 0 = início do
 *  clipe (o karaokê da composição consome estes tempos, sem tocar o banco). */
export function sliceWords(words: TranscriptWord[], startMs: number, endMs: number): TranscriptWord[] {
  return words
    .filter((w) => w.endMs > startMs && w.startMs < endMs)
    .map((w) => ({
      text: w.text,
      startMs: Math.max(0, w.startMs - startMs),
      endMs: Math.max(0, Math.min(endMs, w.endMs) - startMs),
    }))
}

/** Chama o modelo (Sonnet) para selecionar os cortes de uma transcrição. Devolve os
 *  cortes já validados pelo guardrail. Sem chunking: cabe em uma chamada (≤4h). */
export async function analyzeClips(
  transcript: string,
  opts: { model?: string; minDurationSec?: number; maxDurationSec?: number } = {},
): Promise<{ clips: ClipSuggestion[]; model: string }> {
  const minDur = opts.minDurationSec ?? 15
  const maxDur = opts.maxDurationSec ?? 300
  const system =
    "Você é um editor de vídeo que identifica os melhores momentos de um vídeo longo para virarem clipes curtos de redes sociais. " +
    "Receba a TRANSCRIÇÃO (com marcações de tempo aproximadas) e escolha os trechos de maior potencial: ganchos, afirmações " +
    "contra-intuitivas, viradas, explicações fechadas. Para cada corte: título, texto do gancho, uma justificativa curta, e um " +
    `score de 0 a 100 que é APENAS a ordenação relativa dentro DESTE vídeo (não é previsão de desempenho). Cada corte deve ter entre ` +
    `${minDur} e ${maxDur} segundos. O campo source_quote DEVE ser um trecho EXATO e literal copiado da transcrição (é usado para ` +
    "validação — se não bater, o corte é descartado). Escreva em português."
  const user = `TRANSCRIÇÃO:\n\n${transcript}`

  const { data, model } = await callStructured<{ clips: Partial<ClipSuggestion>[] }>({
    system,
    user,
    schema: CLIP_SCHEMA,
    model: opts.model ?? CLIP_ANALYSIS_MODEL,
    effort: "medium",
    maxTokens: 8000,
  })
  return { clips: validateClips(data, transcript, { maxDurationSec: maxDur }), model }
}
