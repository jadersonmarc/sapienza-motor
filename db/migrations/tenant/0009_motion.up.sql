-- Motion (peça em movimento / vídeo animado on-brand): diferencial dos planos Pro e
-- Premium. Marcador + estado de render na peça; os campos do preset (words/quote/
-- slides/stat+source) ficam numa coluna DEDICADA da revisão — não sobrecarrega `seo`.
ALTER TABLE content_items ADD COLUMN is_motion boolean NOT NULL DEFAULT false;
ALTER TABLE content_items ADD COLUMN motion_preset text;   -- headline | quote | slides | stat
ALTER TABLE content_items ADD COLUMN motion_aspect text;   -- 1x1 | 4x5 | 9x16
ALTER TABLE content_items ADD COLUMN video_url text;       -- MP4 renderizado (R2), escrito pelo serviço de render
ALTER TABLE content_items ADD COLUMN render_status text;   -- queued | rendering | done | error
ALTER TABLE content_items ADD COLUMN render_error text;    -- motivo da última falha de render (o console mostra)

ALTER TABLE content_revisions ADD COLUMN motion_props jsonb; -- campos do preset gerados a partir do brief
