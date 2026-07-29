-- Handle da marca (ex.: @cliente) exibido no rodapé das peças de motion. Por tenant,
-- na config do agente (editor_config). Vazio = usa o default do serviço de render.
ALTER TABLE editor_config ADD COLUMN handle text NOT NULL DEFAULT '';
