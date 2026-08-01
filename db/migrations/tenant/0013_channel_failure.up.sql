-- Falha de publicação POR CANAL. Antes só existia o blob content_items.publish_error
-- (agregado). Agora cada canal que falha vira uma linha em social_drafts com
-- status='failed' e o erro em last_error — alimenta a UI por-canal e o reprocesso.
-- status continua text livre (draft|approved|sent|failed), sem enum.
ALTER TABLE social_drafts ADD COLUMN last_error text;
