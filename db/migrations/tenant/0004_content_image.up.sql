-- Imagem on-brand escolhida da peça (gerada ou trocada pela biblioteca). O publish
-- prefere esta imagem; se nula, gera na hora (comportamento antigo). Nullable.
ALTER TABLE content_items ADD COLUMN image_url text;
