-- Fundo-padrão do tenant (Brand Kit): imagens de referência que viram o background
-- das peças de motion sem imagem própria. background_keys guarda URLs de mídia (mesmo
-- formato de content_items.motion_image_url); o cursor faz a rotação DETERMINÍSTICA
-- (round-robin) na criação da peça — peças consecutivas não repetem a mesma imagem.
-- Não expiram (ativo de Brand Kit, não de peça). Limite de 5 aplicado na aplicação.
ALTER TABLE editor_config ADD COLUMN IF NOT EXISTS background_keys jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE editor_config ADD COLUMN IF NOT EXISTS background_cursor integer NOT NULL DEFAULT 0;
