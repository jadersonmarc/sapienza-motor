-- Estilo de legenda do motion (item 8a): default por tenant (Brand Kit) + override
-- por peça. Ambos jsonb nullable — NULL = valores atuais (render byte a byte idêntico).
-- Restrito a tokens (fonte/cor/realce semânticos) na aplicação; ver lib/content/caption-style.ts.
ALTER TABLE editor_config ADD COLUMN IF NOT EXISTS caption_style jsonb;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS motion_caption_style jsonb;
