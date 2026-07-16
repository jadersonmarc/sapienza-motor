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
  (billing na publicação), `regenerate` (limite).
- `lib/channels/` — interface `Channel` + impls (blog/instagram/linkedin) + `MockChannel` + registry (tier gate).
- `lib/provisioning.ts` — consumer do outbox (SubscriptionActivated{motor} → migrations).
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
