-- Imagem de fundo opcional das peças de MOTION (item 7). URL do proxy público do R2
-- (reusa POST /api/v1/media para upload/validação/bucket-por-tenant). Null = sem
-- imagem, a peça renderiza como hoje. Fica na peça (não na revisão) — estável entre
-- regenerações.
ALTER TABLE content_items ADD COLUMN motion_image_url text;
