-- Cadência da automação por tenant: intervalo mínimo (em dias) entre gerações
-- automáticas, e a marca da última geração. O cron dispara diariamente (tick) e
-- só gera para o tenant quando o intervalo já passou.
ALTER TABLE editor_config ADD COLUMN cadence_days int NOT NULL DEFAULT 7;
ALTER TABLE editor_config ADD COLUMN last_auto_at timestamptz;
