-- OAuth + refresh automático de token por canal. credentials_enc segue como a
-- credencial de TRABALHO (o que os adapters leem); estas colunas guardam o ciclo de
-- vida do token para a Sapienza renovar sozinha (o cliente conecta uma vez).
ALTER TABLE motor_channels ADD COLUMN token_expires_at  timestamptz; -- null = não expira / desconhecido (colar-JSON manual)
ALTER TABLE motor_channels ADD COLUMN refresh_token_enc text;        -- cifrado (AES-256-GCM); null = sem refresh (não renovável headless)
