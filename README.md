# sapienza-motor

Data plane do produto **Motor de Conteúdo**: geração, aprovação e publicação multi-canal de
"peças", multi-tenant. Envolve (não reescreve) o pipeline editorial de `../spa-sapienza`.

É um produto **TypeScript** e **não usa o kit Go**: reimplementa a cola de plataforma em
`lib/platform/*` e integra com o core por SQL no `public` (read-only) + append no
`event_outbox` + JWT do core. Sobe **independente** no Coolify, contra o mesmo Postgres.

Não tem UI própria — é só API (`app/` tem apenas route handlers). O console vive no core.

## Como se encaixa

| Repo | Papel | Dono de qual dado |
|---|---|---|
| `sapienza-core` | Control plane + console | schema `public` |
| `sapienza-margot` | Data plane WhatsApp (Go) | schema `margot` + `tenant_<id>` |
| **`sapienza-motor`** (este) | Data plane conteúdo (TS) | suas tabelas em cada `tenant_<id>` |

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · `postgres` (postgres-js, SQL cru) · `jose`
(JWT) · `@anthropic-ai/sdk` · `next/og` (Satori) · `@aws-sdk/client-s3` (R2) · pnpm · vitest.

## Arquitetura

```
lib/platform/     a cola (espelha o kit Go, sem importá-lo): tenancy (withTenant,
                  applyTenantMigrations), gating (read-only em public), events
                  (emitUsageRecorded + cursor), authclient (jose), crypto (AES-GCM), webhook
lib/content/      state-machine, store (SQL cru sob withTenant), transition (billing),
                  regenerate (limite), social-text
lib/ai/           client (Claude, json_schema), generate (draft do cron), brief (rascunho a
                  partir de brief livre), social (legendas), analyzers
lib/channels/     interface Channel + impls + MockChannel + registry (gate por tier)
lib/brand/        imagem on-brand (Satori): tokens (fonte única de cor), formats, templates
lib/storage/      R2/S3 + chaves por finalidade
db/migrations/tenant/  as tabelas do Motor no schema do tenant
app/api/v1/*      API do produto (JWT do core)
app/api/cron/*    jobs (x-webhook-secret)
app/api/og        preview de imagem, público
```

### Modelo de dados (`tenant_<id>`, sem coluna `tenant_id` — o schema é a fronteira)

`content_items` (`status`, `published_at` = guard do billing, `review_deadline_at`,
`regen_count`) · `content_revisions` · `ai_analyses` · `social_drafts` · `audit_log` ·
`motor_channels` (`platform` PK, `credentials_enc`).

### Máquina de estados

```
draft → in_review → scheduled → published → archived
  ↑         ↓           ↓           ↓           ↓
  └─────────┴───────────┴───────────┴───────────┘   (editar/rejeitar volta p/ draft)
```

`contentTransition` é o **único** ponto de mudança de status: grava `audit_log`, seta
`published_at` uma vez e fatura na primeira publicação.

### Regras (de `pricing.yaml` → `plans`/`product_rules`, nunca chumbadas)

- **Faturável = peça publicada.** Na 1ª transição para `published` → `UsageRecorded{peca}` na
  mesma tx. Multi-canal da mesma peça = **1** peça. Excedente R$ 25; tiers 12/30/60.
- **Janela de aprovação (48h)**: `in_review` grava `review_deadline_at`; o cron promove a
  `published` depois do prazo — silêncio é aprovação.
- **Máx. 2 regenerações por peça**; a 3ª é bloqueada.
- **Canais por tier**: 1/2/3 (start/pro/scale).

### Canais

Interface `Channel` (análoga ao driver do Margot) — o pipeline é agnóstico de provedor.
Implementados: `blog` (interno), `instagram`, `linkedin`, `facebook`, `twitter`, `threads`,
mais `MockChannel` para testes. As credenciais **não são env**: chegam por tenant no setup e
ficam cifradas em `motor_channels`.

> **Instagram e Threads exigem imagem.** Sem o storage configurado, `generateAndStoreCover`
> devolve `null` e a publicação segue sem imagem — o que funciona para blog/LinkedIn/X/Facebook,
> mas faz IG/Threads falharem. Se for usar esses dois, configure o R2/S3.

### IA

`ANTHROPIC_API_KEY` é opcional, mas muda o comportamento:

| Caminho | Sem a chave |
|---|---|
| `generate` / `brief` / `social` | fallback determinístico (título cru, corpo mínimo, sem hashtags) |
| `analyzers`, cron `generate-draft` | **503** — exigem IA |

## Regras de ouro

1. **`withTenant` sempre** para dado de conteúdo — o `search_path` é a fronteira.
2. **Não escrever em `public`** — exceto o append no `event_outbox` (via `lib/platform/events.ts`).
3. **jsonb com postgres-js: use `${tx.json(obj)}`**, nunca `${JSON.stringify(obj)}::jsonb` — o
   segundo re-encoda e **quebra o billing**.
4. **Preço/regra nunca chumbados** — ler `plans`/`product_rules`.
5. **Cor só de `lib/brand/tokens`** — há um teste que falha em cor solta nos templates.

## Desenvolvimento

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm provision   # catch-up: migrations dos assinantes ativos + drena o outbox
```

> **Os testes de integração pulam em silêncio sem `TEST_DATABASE_URL`.** `pnpm test` sem ela
> passa verde cobrindo só o que é puro — billing, isolamento, janela de 48h, limite de canais e
> a API **não são exercitados**. Para rodar a suíte inteira:
> ```bash
> docker run -d --name pg-test -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16
> TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres pnpm test
> ```
> Esses testes **dropam o schema `public`** — nunca aponte para um banco real.

`scripts/e2e.sh` sobe o boundary real core↔motor sobre um Postgres e assere billing,
idempotência e isolamento entre dois tenants. É a verificação mais próxima de produção.

## Variáveis de ambiente

| Var | Obrigatória | Observação |
|---|:-:|---|
| `DATABASE_URL` | ✅ | o MESMO Postgres do core |
| `PRODUCT_JWT_SECRET` | ✅ | **o MESMO valor do core**, que emite o JWT; aqui só validamos |
| `MOTOR_ENC_KEY` | ✅ | AES-256-GCM (32 bytes base64). **Perdê-la torna as credenciais de canal já gravadas irrecuperáveis.** |
| `WEBHOOK_SECRET` | ✅ p/ os crons | sem ele `/api/cron/*` nega tudo (fail-closed) |
| `ANTHROPIC_API_KEY` | — | sem ela: fallback nos rascunhos, 503 nos analyzers |
| `S3_ENDPOINT` `S3_BUCKET` `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` `S3_PUBLIC_URL` | p/ imagem | o conjunto **completo** ou nada. `S3_PUBLIC_URL` também é a allowlist do `/api/og`. |

As credenciais de Instagram/LinkedIn/Facebook/X/Threads **não são env** — vêm por tenant no
setup, cifradas em `motor_channels`. Veja `GET /api/v1/setup` para o que cada plataforma exige.

## Deploy

Ver **[`../sapienza-core/DEPLOY.md`](../sapienza-core/DEPLOY.md)**. O boot é
`pnpm provision && pnpm start` — idempotente, sem passo manual de migration.

Crons em `.github/workflows/` (secrets `MOTOR_URL`, `WEBHOOK_SECRET`):
`publish-scheduled` (10min) · `close-approval-window` (15min) · `provision` (1h) ·
`generate-draft` (seg/qua/sex).

## Estado atual

O núcleo — isolamento entre tenants, billing por peça publicada, janela de aprovação, limite de
regenerações e canais por tier — está coberto por testes de integração contra um Postgres real.

Em evolução: a voz usada na geração de conteúdo ainda é única para toda a plataforma (não há
brand/tom por tenant no modelo de dados).

Ver também `SPEC.md`, `CLAUDE.md`, `AGENTS.md` e `../INVENTORY.md`.
