# CLAUDE.md — sapienza-motor

## O que é

Data plane do produto **Motor de Conteúdo** (geração/aprovação/publicação de peças
multi-canal) da plataforma Sapienza. **TypeScript** (Next.js), **não usa o kit Go**.
Envolve o pipeline editorial de `../spa-sapienza`. Ver `SPEC.md` e `AGENTS.md`.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript + pnpm.
- `postgres` (postgres-js, SQL cru). `jose` (JWT do core). `@anthropic-ai/sdk` (Claude).
  `@aws-sdk/client-s3` (R2). `next/og` (Satori, imagem).
- Compartilha o MESMO Postgres do core: `public` (só lê) + `tenant_<id>` (suas tabelas).

## Comandos

```bash
pnpm install
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest — exige TEST_DATABASE_URL (integração)
pnpm build                # next build
```

## Estrutura

- `lib/platform/` — cola de plataforma em TS (espelha o kit Go, sem importá-lo):
  `tenancy` (schemaName/withTenant/applyTenantMigrations), `gating`
  (canOperate/tierOf/channelLimit, read-only em public), `events`
  (emitUsageRecorded + consumer), `authclient` (verifyProductToken jose), `crypto` (AES-256-GCM).
- `db/migrations/tenant/*.up.sql` — tabelas do Motor no schema do tenant.
- `lib/content/` — `state-machine`, `store` (SQL cru sob withTenant), `transition`
  (billing na publicação), `regenerate` (limite), `social-text` (parseHashtags puro).
- `lib/ai/` — `client` (callStructured, Claude json_schema), `generate` (draft rico do cron + seam/fallback),
  `brief` (produtor SEPARADO do cron: rascunho a partir de brief livre — não importa `generate`),
  `social` (legendas IG/LinkedIn + fallback), `analyzers` (quality/seo/emotional/thematic, exigem IA).
  Endpoints: `content` (prompt), `content/brief` (brief), `content/[id]/social`, `content/[id]/analyze`.
  Publish prefere a legenda social gerada ao markdown cru (IG/LinkedIn).
- `lib/channels/` — interface `Channel` + impls (blog/instagram/linkedin/facebook/twitter/threads) +
  `MockChannel` + registry (tier gate). Credenciais por canal chegam decifradas (JSON) do `motor_channels`.
- `lib/brand/` — renderer de imagem on-brand (`next/og`/Satori, extraído de spa-sapienza):
  `tokens` (fonte única sRGB), `formats`, `fonts` (TTFs em `assets/fonts`), `render`,
  `compose` (entrada→arquétipo), `templates/*` (capa/conceito/diagrama/carrossel/bastidores +
  signature), `pillar` (pilar texto livre → tratamento), `social-image` (compõe+rende+sobe no R2).
  Floor: contraste AA, guarda anti-cor-solta (só `tokens`), determinismo do PNG.
- `lib/storage/` — R2/S3 (`s3` upload/list, `keys` chaves por finalidade). Seam: sem env S3_*, publica sem imagem.
- `app/api/og` — render on-demand (preview do composer; público, cacheado por URL).
- `lib/provisioning.ts` — consumer do outbox (SubscriptionActivated{motor} → migrations);
  `catchUp` roda no boot (`pnpm provision`, `scripts/provision.ts`).
- `app/api/v1/*` — API do produto (JWT do core via `lib/api/http.ts`): `content`
  (list/get/create), `content/[id]/{transition,regenerate,publish}`, `channels`, `setup`.
- `app/api/cron/*` — route handlers protegidos por `x-webhook-secret` (`lib/platform/webhook.ts`):
  `publish-scheduled`, `close-approval-window` (janela 48h), `provision` (drena o outbox),
  `generate-draft` (gera 1 peça em draft por tenant ativo; renovação de tema via themeGuidance; exige IA).
- `lib/testutil.ts` — sobe o subconjunto do control plane + trigger de uso + provisiona tenants.

## Convenções

- **`withTenant` sempre** para dado de conteúdo (search_path é a fronteira; sem `tenant_id`).
- **Não escrever em `public`** exceto append no `event_outbox` (via `events.ts`).
- **jsonb com postgres-js**: usar `${tx.json(obj)}` — nunca `${JSON.stringify(obj)}::jsonb`
  (re-encoda e quebra o billing).
- **Preço/regra nunca chumbados** — ler `plans`/`product_rules`.
- Segredos nunca em claro no repo; testes usam mocks.

## Restrições

- Não editar `../spa-sapienza`, `../sapienza-core`, `../sapienza-margot` fora do combinado.
- Não criar tabelas no `public`. Não importar o kit Go (é produto TS).
