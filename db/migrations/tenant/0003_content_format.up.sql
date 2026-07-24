-- Formato da peça = o canal-alvo do conteúdo. blog = artigo longo/SEO (o padrão
-- histórico); linkedin/instagram = post curto do canal. Aditiva, forward-only.
ALTER TABLE content_items ADD COLUMN format text NOT NULL DEFAULT 'blog';
