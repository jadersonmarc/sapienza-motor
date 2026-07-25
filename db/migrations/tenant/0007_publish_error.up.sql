-- Publicação em segundo plano: a request retorna na hora e o post acontece logo
-- depois (sem estourar o proxy). Se falhar no background, o motivo fica aqui para
-- o console mostrar; é limpo quando a publicação dá certo.
ALTER TABLE content_items ADD COLUMN publish_error text;
