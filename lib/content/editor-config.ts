import type { Tx } from "@/lib/db"
import type { CaptionStyle } from "./caption-style"

// Config do agente de criação (Margot Editora) por tenant. Singleton na tabela
// editor_config (uma linha). Tenant-scoped (withTenant). Sem linha = defaults.

export type ContentFormat = "blog" | "linkedin" | "instagram"

export type EditorConfig = {
  system_prompt: string
  tone: string
  themes: string[]
  format: ContentFormat
  model: string | null
  enabled: boolean
  cadence_days: number
  /** Handle da marca no rodapé das peças de motion (ex.: @cliente). Vazio = default. */
  handle: string
  /** URL pública (https) do logo da marca no rodapé. Vazio = monograma (inicial do handle). */
  logo_url: string
  /** Estilo de legenda default das peças de motion (Brand Kit). null = valores atuais. */
  caption_style: CaptionStyle | null
  /** Fundos-padrão do tenant (Brand Kit): URLs de mídia (mesmo formato de
   *  motion_image_url). Peça sem imagem própria pega um por rotação. Máx. 5. */
  background_keys: string[]
}

const DEFAULTS: EditorConfig = {
  system_prompt: "",
  tone: "",
  themes: [],
  format: "blog",
  model: null,
  enabled: true,
  cadence_days: 7,
  handle: "",
  logo_url: "",
  caption_style: null,
  background_keys: [],
}

export async function getEditorConfig(tx: Tx): Promise<EditorConfig> {
  const rows = (await tx`
    SELECT system_prompt, tone, themes, format, model, enabled, cadence_days, handle, logo_url, caption_style, background_keys FROM editor_config WHERE id = true
  `) as unknown as {
    system_prompt: string
    tone: string
    themes: unknown
    format: string
    model: string | null
    enabled: boolean
    cadence_days: number
    handle: string | null
    logo_url: string | null
    caption_style: CaptionStyle | null
    background_keys: unknown
  }[]
  const r = rows[0]
  if (!r) return { ...DEFAULTS }
  const format: ContentFormat = r.format === "linkedin" || r.format === "instagram" ? r.format : "blog"
  return {
    system_prompt: r.system_prompt ?? "",
    tone: r.tone ?? "",
    themes: Array.isArray(r.themes) ? (r.themes as string[]) : [],
    format,
    model: r.model,
    enabled: r.enabled,
    cadence_days: r.cadence_days ?? 7,
    handle: r.handle ?? "",
    logo_url: r.logo_url ?? "",
    caption_style: r.caption_style ?? null,
    background_keys: Array.isArray(r.background_keys) ? (r.background_keys as string[]) : [],
  }
}

export async function upsertEditorConfig(tx: Tx, cfg: EditorConfig): Promise<void> {
  await tx`
    INSERT INTO editor_config (id, system_prompt, tone, themes, format, model, enabled, cadence_days, handle, logo_url, caption_style, background_keys, updated_at)
    VALUES (true, ${cfg.system_prompt}, ${cfg.tone}, ${tx.json(cfg.themes)}, ${cfg.format}, ${cfg.model}, ${cfg.enabled}, ${cfg.cadence_days}, ${cfg.handle}, ${cfg.logo_url}, ${cfg.caption_style ? tx.json(cfg.caption_style) : null}, ${tx.json(cfg.background_keys)}, now())
    ON CONFLICT (id) DO UPDATE SET
      system_prompt = EXCLUDED.system_prompt,
      tone = EXCLUDED.tone,
      themes = EXCLUDED.themes,
      format = EXCLUDED.format,
      model = EXCLUDED.model,
      enabled = EXCLUDED.enabled,
      cadence_days = EXCLUDED.cadence_days,
      handle = EXCLUDED.handle,
      logo_url = EXCLUDED.logo_url,
      caption_style = EXCLUDED.caption_style,
      background_keys = EXCLUDED.background_keys,
      -- Bump a versão só quando muda algo que afeta a GERAÇÃO (prompt/tom/temas/
      -- modelo) — não em toggles de enabled/cadência/handle. Cada peça carimba
      -- esta versão na criação (proveniência p/ correlacionar com métricas).
      config_version = editor_config.config_version + CASE WHEN (
             editor_config.system_prompt IS DISTINCT FROM EXCLUDED.system_prompt
          OR editor_config.tone          IS DISTINCT FROM EXCLUDED.tone
          OR editor_config.themes        IS DISTINCT FROM EXCLUDED.themes
          OR editor_config.model         IS DISTINCT FROM EXCLUDED.model
        ) THEN 1 ELSE 0 END,
      updated_at = now()
  `
}

/** Escolhe o próximo fundo-padrão do Brand Kit por ROTAÇÃO determinística (round-robin):
 *  avança o cursor ATOMICAMENTE e devolve a URL no índice. null se não há fundos. Como
 *  o cursor anda de 1 em 1, peças consecutivas não caem na mesma imagem enquanto houver
 *  mais de uma. Chamado na criação da peça (estável em re-render). */
export async function pickBrandBackground(tx: Tx): Promise<string | null> {
  const rows = (await tx`
    UPDATE editor_config SET background_cursor = background_cursor + 1
     WHERE id = true
     RETURNING background_cursor, background_keys
  `) as unknown as { background_cursor: number; background_keys: unknown }[]
  const r = rows[0]
  if (!r) return null
  const keys = Array.isArray(r.background_keys) ? (r.background_keys as string[]) : []
  if (keys.length === 0) return null
  const idx = (r.background_cursor - 1) % keys.length
  return keys[idx] ?? null
}

/** Já passou o intervalo da cadência desde a última geração automática? (sem
 *  linha/nunca gerou = sim). Não considera o `enabled` — o cron checa isso à parte. */
export async function dueForAuto(tx: Tx, cadenceDays: number): Promise<boolean> {
  const rows = (await tx`
    SELECT (last_auto_at IS NULL OR now() - last_auto_at >= make_interval(days => ${cadenceDays})) AS due
      FROM editor_config WHERE id = true
  `) as unknown as { due: boolean }[]
  return rows[0]?.due ?? true
}

/** Marca a última geração automática = agora (cria a linha se não existir). */
export async function markAutoGenerated(tx: Tx): Promise<void> {
  await tx`
    INSERT INTO editor_config (id, last_auto_at) VALUES (true, now())
    ON CONFLICT (id) DO UPDATE SET last_auto_at = now()
  `
}
