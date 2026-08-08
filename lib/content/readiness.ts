import type { Sql } from "@/lib/db"
import { withTenant } from "@/lib/platform/tenancy"
import { getEditorConfig, type EditorConfig } from "@/lib/content/editor-config"
import { connectedFormats, enabledChannels } from "@/lib/channels/registry"
import type { ContentFormat } from "@/lib/ai/generate"

// Antes de criar QUALQUER peça, o tenant precisa estar PRONTO:
//  1. Agente com IDENTIDADE definida (persona/voz) — não existe marca padrão, então
//     sem isso o conteúdo sairia sem dono. É a correção do "vinha com identidade da Sapienza".
//  2. Ao menos um CANAL de publicação conectado — senão a peça nasceria sem destino
//     (era o bug de criar motion "para o instagram" sem canal).
export class NotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NotReadyError"
  }
}

/** Garante identidade + ≥1 canal. Devolve a config e os formatos com canal conectado. */
export async function assertReadyToCreate(
  sql: Sql,
  tenantId: string,
): Promise<{ cfg: EditorConfig; formats: ContentFormat[] }> {
  const cfg = await withTenant(sql, tenantId, (tx) => getEditorConfig(tx))
  if (!cfg.system_prompt.trim()) {
    throw new NotReadyError("Configure a identidade da marca no Agente antes de criar peças.")
  }
  const formats = await connectedFormats(sql, tenantId)
  if (formats.length === 0) {
    throw new NotReadyError("Conecte um canal de publicação antes de criar peças.")
  }
  return { cfg, formats }
}

/** Plataformas (canais) conectadas do tenant — usado p/ validar o destino do vídeo. */
export async function connectedPlatforms(sql: Sql, tenantId: string): Promise<Set<string>> {
  return new Set((await enabledChannels(sql, tenantId)).map((c) => c.platform))
}
