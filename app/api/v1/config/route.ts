import { authed, isResponse, json, requireRole } from "@/lib/api/http"
import { getDb } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { getEditorConfig, upsertEditorConfig, type ContentFormat, type EditorConfig } from "@/lib/content/editor-config"

export const runtime = "nodejs"

const FORMATS: ContentFormat[] = ["blog", "linkedin", "instagram"]

// GET /api/v1/config — config do agente de criação (Margot Editora) do tenant.
export async function GET(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const sql = getDb()
  const cfg = await withTenant(sql, a.tenantId, (tx) => getEditorConfig(tx))
  return json(200, cfg)
}

// PUT /api/v1/config — salva a config (owner/admin).
export async function PUT(req: Request): Promise<Response> {
  const a = await authed(req)
  if (isResponse(a)) return a
  const denied = requireRole(a, ["owner", "admin"])
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as Partial<EditorConfig> & { themes?: unknown }
  const format = FORMATS.includes(body.format as ContentFormat) ? (body.format as ContentFormat) : "blog"
  const themes = Array.isArray(body.themes)
    ? (body.themes as unknown[]).map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
    : []
  const cfg: EditorConfig = {
    system_prompt: String(body.system_prompt ?? "").trim(),
    tone: String(body.tone ?? "").trim(),
    themes,
    format,
    model: body.model ? String(body.model).trim() : null,
    enabled: body.enabled !== false,
  }

  const sql = getDb()
  await withTenant(sql, a.tenantId, (tx) => upsertEditorConfig(tx, cfg))
  return json(200, { ok: true })
}
