-- Fan-out multi-formato: além do video_url (formato principal, usado na publicação),
-- guardamos TODOS os formatos renderizados da mesma peça (map aspecto→URL do MP4).
-- Default '{}' — peças antigas seguem só com video_url.
ALTER TABLE content_items ADD COLUMN video_urls jsonb NOT NULL DEFAULT '{}';
