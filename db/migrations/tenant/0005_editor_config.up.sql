-- Config do agente de criação (Margot Editora) por tenant: personaliza a voz/tom,
-- temas, formato e modelo da geração automática (cron) e manual. Singleton por schema.
CREATE TABLE editor_config (
    id            boolean PRIMARY KEY DEFAULT true,  -- garante uma única linha
    system_prompt text NOT NULL DEFAULT '',          -- voz da marca / instruções
    tone          text NOT NULL DEFAULT '',          -- tom (ex.: profissional e direto)
    themes        jsonb NOT NULL DEFAULT '[]',        -- áreas a priorizar (themeSeeds)
    format        text NOT NULL DEFAULT 'blog',       -- blog | linkedin | instagram
    model         text,                               -- modelo da IA (null = padrão do produto)
    enabled       boolean NOT NULL DEFAULT true,      -- automação ligada para o tenant
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT editor_config_singleton CHECK (id)
);
