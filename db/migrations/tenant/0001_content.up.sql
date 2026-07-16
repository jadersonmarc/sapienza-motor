-- Tabelas do Motor no schema do tenant (tenant_<id>). Sem coluna tenant_id: o
-- schema é a fronteira de isolamento (aplicado sob search_path via withTenant).
-- Adaptado de spa-sapienza/lib/db/schema.ts (conteúdo), + campos da plataforma:
-- review_deadline_at (janela de aprovação 48h) e regen_count (limite de regeneração).

CREATE TABLE content_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type                text NOT NULL DEFAULT 'post',    -- post | page
    slug                text NOT NULL UNIQUE,
    pilar               text,                            -- p1 | p2 | p3 (nullable)
    vertente            text,                            -- campanha/produto (nullable)
    cover_image_url     text,
    status              text NOT NULL DEFAULT 'draft',   -- draft|in_review|scheduled|published|archived
    current_revision_id uuid,
    review_deadline_at  timestamptz,                     -- silêncio até aqui = aprovado (janela 48h)
    scheduled_at        timestamptz,
    published_at        timestamptz,                     -- setado uma vez na 1ª publicação (faturável)
    regen_count         integer NOT NULL DEFAULT 0,      -- regenerações por IA (máx do product_rules)
    author_id           uuid,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_content_items_status ON content_items (status);
CREATE INDEX idx_content_items_review ON content_items (review_deadline_at);
CREATE INDEX idx_content_items_scheduled ON content_items (scheduled_at);

CREATE TABLE content_revisions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content_item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    title           text NOT NULL,
    body_markdown   text NOT NULL,
    excerpt         text,
    seo             jsonb NOT NULL DEFAULT '{}',
    ai_generated    boolean NOT NULL DEFAULT false,   -- distingue regeneração por IA
    author_id       uuid,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_content_revisions_item ON content_revisions (content_item_id, created_at);

CREATE TABLE ai_analyses (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content_item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    revision_id     uuid REFERENCES content_revisions(id) ON DELETE CASCADE,
    type            text NOT NULL,                    -- quality|seo|emotional|thematic
    payload         jsonb NOT NULL DEFAULT '{}',
    model           text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE social_drafts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content_item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    revision_id     uuid REFERENCES content_revisions(id) ON DELETE SET NULL,
    platform        text NOT NULL,                    -- instagram|linkedin|blog
    body            text NOT NULL DEFAULT '',
    hashtags        jsonb NOT NULL DEFAULT '[]',
    status          text NOT NULL DEFAULT 'draft',    -- draft|approved|sent
    image_url       text,
    post_url        text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_social_drafts_item ON social_drafts (content_item_id);

-- Base auditável do faturamento: linhas com to_status='published'.
CREATE TABLE audit_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content_item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    actor_id        uuid,
    from_status     text,
    to_status       text NOT NULL,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Canais conectados do tenant (limitados pelo `canais` do tier). PK = platform
-- (um por plataforma por tenant). Credenciais cifradas (AES-256-GCM).
CREATE TABLE motor_channels (
    platform        text PRIMARY KEY,                 -- instagram|linkedin|blog
    credentials_enc text,
    enabled         boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
