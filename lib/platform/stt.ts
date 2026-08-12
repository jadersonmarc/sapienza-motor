// Espelho TS do contrato de STT do kit (sapienza-kit/stt) — o Motor é TS e não
// importa o kit Go, então reimplementa o MESMO contrato aqui (como faz com
// tenancy/gating/events). Um provedor, dois produtos: a Editora (Clipper) pede
// wordTimestamps para o karaokê e o casamento do corte; a Atendente (lado Go) usa
// o mesmo contrato sem palavras. Default OpenAI-compatible (/audio/transcriptions),
// funciona com OpenAI e Groq (Whisper), selecionado por env.

export type SttWord = { text: string; startMs: number; endMs: number }
export type SttResult = { text: string; lang: string; words: SttWord[] }
export type SttOptions = { wordTimestamps?: boolean; language?: string }

export class SttNotConfiguredError extends Error {
  constructor() {
    super("stt: provider not configured")
  }
}

export interface SttProvider {
  configured(): boolean
  transcribe(audio: Buffer, mime: string, opts?: SttOptions): Promise<SttResult>
}

/** Seam desligado: sem provedor configurado (o chamador cai no fallback). */
export class NoopStt implements SttProvider {
  configured(): boolean {
    return false
  }
  async transcribe(_audio: Buffer, _mime: string, _opts?: SttOptions): Promise<SttResult> {
    throw new SttNotConfiguredError()
  }
}

/** Provedor HTTP OpenAI-compatible (OpenAI ou Groq/Whisper). */
export class HttpStt implements SttProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = 5 * 60_000,
  ) {}

  configured(): boolean {
    return true
  }

  async transcribe(audio: Buffer, mime: string, opts: SttOptions = {}): Promise<SttResult> {
    const form = new FormData()
    form.set("file", new Blob([new Uint8Array(audio)], { type: mime }), filenameFor(mime))
    form.set("model", this.model)
    if (opts.language) form.set("language", opts.language)
    // Word timestamps: verbose_json + granularidade por palavra (OpenAI/Groq Whisper).
    if (opts.wordTimestamps) {
      form.set("response_format", "verbose_json")
      form.set("timestamp_granularities[]", "word")
    }

    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`stt: status ${res.status}: ${body}`)

    let parsed: {
      text?: string
      language?: string
      words?: { word: string; start: number; end: number }[]
    }
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Error(`stt: decode: ${body.slice(0, 200)}`)
    }
    return {
      text: parsed.text ?? "",
      lang: parsed.language ?? "",
      words: (parsed.words ?? []).map((w) => ({
        text: w.word,
        startMs: Math.round(w.start * 1000),
        endMs: Math.round(w.end * 1000),
      })),
    }
  }
}

/** Extensão por mime para o provedor detectar o formato do áudio. */
export function filenameFor(mime: string): string {
  if (mime.includes("ogg")) return "audio.ogg"
  if (mime.includes("mp4") || mime.includes("m4a")) return "audio.m4a"
  if (mime.includes("wav")) return "audio.wav"
  if (mime.includes("mpeg") || mime.includes("mp3")) return "audio.mp3"
  return "audio.mp3"
}

/** Provedor pelas envs: HttpStt quando STT_API_KEY existe, senão Noop. STT_BASE_URL
 *  default OpenAI; aponte para Groq (https://api.groq.com/openai/v1) +
 *  STT_MODEL=whisper-large-v3-turbo para usar Groq. */
export function sttFromEnv(): SttProvider {
  const key = process.env.STT_API_KEY
  if (!key) return new NoopStt()
  const base = process.env.STT_BASE_URL || "https://api.openai.com/v1"
  const model = process.env.STT_MODEL || "whisper-1"
  return new HttpStt(base, key, model)
}
