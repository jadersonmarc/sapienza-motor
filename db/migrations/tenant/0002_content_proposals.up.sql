-- Revisões PROPOSTAS pela IA: entram sem virar a revisão atual da peça. O usuário
-- vê o diff e aceita (a proposta vira current) ou descarta. is_proposed=false é a
-- revisão normal (a que addRevision cria). Aditiva e forward-only.
ALTER TABLE content_revisions ADD COLUMN is_proposed boolean NOT NULL DEFAULT false;
ALTER TABLE content_revisions ADD COLUMN proposed_from jsonb;
CREATE INDEX idx_content_revisions_proposed ON content_revisions (content_item_id, is_proposed);
