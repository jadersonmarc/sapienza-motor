-- Logo da marca do tenant no rodapé das peças de motion. Por tenant, na config do
-- agente (editor_config). Vazio = usa o monograma (inicial do handle). Só marca
-- visual — não afeta a geração (não entra no bump de config_version).
ALTER TABLE editor_config ADD COLUMN logo_url text NOT NULL DEFAULT '';
