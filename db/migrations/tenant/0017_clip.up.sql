-- Clipes Inteligentes: corta vídeo longo em clipes verticais com legenda karaokê.
-- Um clipe é um content_item (herda aprovação/publicação/faturamento), marcado por
-- is_clip e ligado à sua fonte (clip_sources). Reusa as colunas genéricas de render
-- (render_status/render_error/video_url/video_urls) do motion — o worker do clipe
-- filtra por is_clip, então não colide com o worker do motion (is_motion). As props
-- do clipe (janela de corte, estilo de legenda, card de abertura) ficam numa coluna
-- DEDICADA da revisão (clip_props), como motion_props — não sobrecarrega `seo`.
ALTER TABLE content_items ADD COLUMN is_clip boolean NOT NULL DEFAULT false;
ALTER TABLE content_items ADD COLUMN clip_source_id uuid;   -- fonte que originou este clipe
ALTER TABLE content_items ADD COLUMN clip_aspect text;      -- 9x16 | 16x9

ALTER TABLE content_revisions ADD COLUMN clip_props jsonb;  -- janela de corte, legenda, card de abertura

CREATE INDEX idx_content_items_clip ON content_items (is_clip, render_status);

-- Fonte de vídeo: o job de ingestão→transcrição→análise→geração de clipes. Estados
-- (status) formam a esteira retomável; o worker reivindica com claim atômico
-- (FOR UPDATE SKIP LOCKED) para escalar em réplicas sem processar em duplicidade.
CREATE TABLE clip_sources (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind              text NOT NULL,                    -- upload | url
    origin            text NOT NULL,                    -- URL de origem ou nome do arquivo
    content_hash      text,                             -- idempotência (mesmo vídeo não reprocessa/recobra)
    r2_key_raw        text,                             -- chave do vídeo-fonte bruto no R2
    duration_seconds  integer,                          -- preenchido no probe (ffprobe)
    size_bytes        bigint,
    status            text NOT NULL DEFAULT 'queued',   -- queued|downloading|probing|extracting_audio|transcribing|analyzing|generating|done|error
    error             text,                             -- motivo da última falha (o console mostra)
    transcript_id     uuid,                             -- clip_transcripts (ciclo de vida próprio)
    minutes_charged   integer NOT NULL DEFAULT 0,       -- minutos debitados de clipper_hours (para refund idempotente)
    clips_count       integer NOT NULL DEFAULT 0,       -- nº de clipes gerados (ranking/UI)
    author_id         uuid,
    claimed_at        timestamptz,                      -- lease do claim atômico (retomada após crash)
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    raw_expires_at    timestamptz,                      -- remoção do bruto (7d após processar)
    expires_at        timestamptz,                      -- remoção da fonte/JSON (60d)
    warned_at         timestamptz                       -- aviso de expiração já enviado (idempotência)
);
CREATE INDEX idx_clip_sources_status ON clip_sources (status, created_at);
CREATE UNIQUE INDEX idx_clip_sources_hash ON clip_sources (content_hash) WHERE content_hash IS NOT NULL;

-- Transcrição separada do vídeo-fonte (ciclo de vida próprio, 60d): é leve e permite
-- regerar clipes sem reingerir o vídeo e sem recobrar horas. words = alinhamento por
-- palavra ([{t,s,e}...]) que alimenta o karaokê e o casamento com o source_quote.
CREATE TABLE clip_transcripts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id   uuid NOT NULL REFERENCES clip_sources(id) ON DELETE CASCADE,
    lang        text,
    text        text NOT NULL,
    words       jsonb NOT NULL DEFAULT '[]',
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz
);
CREATE INDEX idx_clip_transcripts_source ON clip_transcripts (source_id);
