-- Conectores de nuvem do Clipper (Onda 2): o tenant conecta a conta (Google Drive /
-- Dropbox) uma vez via OAuth; a Sapienza guarda o token (cifrado) e renova sozinha.
-- PK = provider (um por provedor por tenant). Credenciais/refresh cifrados
-- (AES-256-GCM), como motor_channels.
CREATE TABLE clip_connectors (
    provider        text PRIMARY KEY,            -- gdrive | dropbox
    credentials_enc text,                        -- access token cifrado
    refresh_enc     text,                        -- refresh token cifrado (renovação)
    expires_at      timestamptz,                 -- validade do access token
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
