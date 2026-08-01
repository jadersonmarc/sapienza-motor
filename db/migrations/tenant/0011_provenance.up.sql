-- Proveniência: ligar cada peça a COMO foi gerada. editor_config ganha uma versão
-- que sobe quando muda um campo que afeta a geração; cada peça carimba a versão
-- vigente na criação. Assim as métricas (post_metrics) podem correlacionar
-- desempenho × configuração de geração.
ALTER TABLE editor_config ADD COLUMN IF NOT EXISTS config_version int NOT NULL DEFAULT 1;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS config_version int;
