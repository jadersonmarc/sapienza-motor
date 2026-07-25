import type { Tx } from "@/lib/db"

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
}

const DEFAULTS: EditorConfig = {
  system_prompt: "",
  tone: "",
  themes: [],
  format: "blog",
  model: null,
  enabled: true,
}

export async function getEditorConfig(tx: Tx): Promise<EditorConfig> {
  const rows = (await tx`
    SELECT system_prompt, tone, themes, format, model, enabled FROM editor_config WHERE id = true
  `) as unknown as {
    system_prompt: string
    tone: string
    themes: unknown
    format: string
    model: string | null
    enabled: boolean
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
  }
}

export async function upsertEditorConfig(tx: Tx, cfg: EditorConfig): Promise<void> {
  await tx`
    INSERT INTO editor_config (id, system_prompt, tone, themes, format, model, enabled, updated_at)
    VALUES (true, ${cfg.system_prompt}, ${cfg.tone}, ${tx.json(cfg.themes)}, ${cfg.format}, ${cfg.model}, ${cfg.enabled}, now())
    ON CONFLICT (id) DO UPDATE SET
      system_prompt = EXCLUDED.system_prompt,
      tone = EXCLUDED.tone,
      themes = EXCLUDED.themes,
      format = EXCLUDED.format,
      model = EXCLUDED.model,
      enabled = EXCLUDED.enabled,
      updated_at = now()
  `
}
