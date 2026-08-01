-- Fundação de dado: métricas de desempenho como SÉRIE TEMPORAL (snapshot diário),
-- não leitura pontual. Dia = calendário São Paulo (mesma convenção do período).

-- Fato por peça × canal × dia. Juntável a content_items (pilar/formato/preset/
-- config_version) para correlacionar geração × desempenho. Upsert idempotente por dia.
CREATE TABLE IF NOT EXISTS post_metrics (
    content_item_id uuid NOT NULL REFERENCES content_items (id) ON DELETE CASCADE,
    platform        text NOT NULL,
    day             date NOT NULL,
    impressions     int,
    reach           int,
    likes           int,
    comments        int,
    shares          int,
    saves           int,
    clicks          int,
    fetched_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (content_item_id, platform, day)
);
CREATE INDEX IF NOT EXISTS idx_post_metrics_day ON post_metrics (day);

-- Série diária de conta (por canal): seguidores/alcance ao longo do tempo.
CREATE TABLE IF NOT EXISTS channel_metrics (
    platform   text NOT NULL,
    day        date NOT NULL,
    followers  int,
    reach      int,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (platform, day)
);
