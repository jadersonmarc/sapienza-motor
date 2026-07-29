-- Geração de rascunho em segundo plano: a request de criar/gerar retorna na hora
-- (202) e o modelo escreve depois, via after() — imune a corte de proxy (ex.: o
-- limite de ~100s do Cloudflare). Enquanto gera, generating=true (o console mostra
-- "gerando…" e faz auto-refresh); se falhar, o motivo fica em generate_error (o
-- console mostra); é limpo quando dá certo.
ALTER TABLE content_items ADD COLUMN generating boolean NOT NULL DEFAULT false;
ALTER TABLE content_items ADD COLUMN generate_error text;
