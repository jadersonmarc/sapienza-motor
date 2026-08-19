-- Endurecimento da ingestão + regeração (itens 2/3/4):
-- - content_items.brief: o brief/prompt ORIGINAL da peça, persistido na criação,
--   para a regeração combinar "brief original + feedback" em vez de substituir.
-- - clip_sources.error_raw: erro CRU (yt-dlp/inglês/stack) em campo INTERNO — o
--   `error` fica com a mensagem pt-BR amigável; error_raw permite diagnosticar
--   quebra de extractor depois.
-- - clip_sources.requeue_count: nº de retomadas de uma fonte presa; passado o
--   limite, falha com motivo explícito em vez de reprocessar para sempre.
ALTER TABLE content_items ADD COLUMN brief text;

ALTER TABLE clip_sources ADD COLUMN error_raw     text;
ALTER TABLE clip_sources ADD COLUMN requeue_count integer NOT NULL DEFAULT 0;
