# SPEC — sapienza-motor

Data plane **Motor de Conteúdo**: geração, aprovação e publicação de "peças"
(posts) multi-canal, multi-tenant. Envolve (não reescreve) o pipeline editorial de
`spa-sapienza` e o pluga na plataforma Sapienza (control plane `sapienza-core`).

## Topologia

| Repo | Papel | Dono de qual dado | Deploy |
|---|---|---|---|
| `sapienza-core` | Control plane + console | schema `public` | serviço Coolify |
| `sapienza-margot` | Data plane WhatsApp (Go) | schema `margot` + `tenant_<id>` | serviço Coolify |
| `sapienza-motor` (este) | Data plane conteúdo (TS) | suas tabelas em cada `tenant_<id>` | serviço Coolify |

O Motor é **TypeScript** e **NÃO importa o kit Go**: reimplementa em TS a cola de
plataforma (`lib/platform/*`) e integra com o core por **SQL no `public`** (read-only)
+ **append no `event_outbox`** + **JWT do core**.

## Regras de ouro

1. Um Postgres. `public` = control plane; `tenant_<id>` = dados do produto.
2. Motor **só LÊ `public`** (subscriptions/plans/product_rules); única escrita
   sancionada = **append no `public.event_outbox`** (uso) + cursor em `bus.event_cursors`.
3. Motor é dono só das suas tabelas nos `tenant_<id>`; roda suas próprias migrations.
4. Todo acesso a dado de conteúdo passa por `withTenant` (search_path). Isolamento = aceite.
5. Preço/tier/regra vêm de `pricing.yaml` (core) → lidos de `plans`/`product_rules`.

## Métrica & regras (de `pricing.yaml > produtos.motor`)

- **Faturável = "peça publicada"**: na **1ª** transição de um `content_item` para
  `published` → `UsageRecorded{metric:"peca",count:1}` no outbox (mesma tx). Multi-canal
  da mesma peça = **1** peça. Excedente R$ 25/peça. Tiers 12/30/60.
- **Janela de aprovação (`janela_aprovacao_horas`, 48h)**: `in_review` grava
  `review_deadline_at`; o cron promove a `published` após o prazo (silêncio = aprovado).
- **Máx. regenerações (`max_regeneracoes_por_peca`, 2)**: `content_items.regen_count`;
  a 3ª é bloqueada (vira pedido customizado/excedente).
- **Canais por tier (`plans.canais`, 1/2/3)**: conectar/publicar acima do limite → bloqueado.

## Máquina de estados

`draft → in_review → scheduled → published → archived` (volta a `draft` em edição).
`contentTransition` é o **único** ponto de mudança de status (grava `audit_log`, seta
`published_at` uma vez, fatura na 1ª publicação).

## Canais

Interface `Channel` (análoga ao WhatsAppDriver do Margot): `blog` (interno),
`instagram`/`linkedin` (APIs oficiais, credenciais por-tenant cifradas AES-256-GCM) e
`MockChannel` (testes). O pipeline é agnóstico de provedor.

## Integração com a plataforma

- **Gating**: `lib/platform/gating.ts` lê `public.subscriptions/plans/product_rules`.
- **Uso**: `emitUsageRecorded` → `public.event_outbox` → trigger do core agrega `usage_counters`.
- **Provisioning**: consumer (`lib/provisioning.ts`) escuta `SubscriptionActivated{motor}`
  no outbox (cursor `bus.event_cursors`) → aplica migrations de tenant.
- **Auth API**: `verifyProductToken` (JWT curto do core, jose HS256, issuer sapienza-core).

## Onboarding (credenciais no setup do cliente)

Instagram (`access_token`+`account_id`), LinkedIn (`access_token`+`author_urn`), Blog
(interno), R2/S3 (imagem pública p/ IG). Nº de canais = `canais` do tier.

## Aceite

Isolamento (vazamento zero), billing por peça publicada refletido em `usage_counters`,
janela 48h, limite de 2 regenerações, canais por tier, provisioning por evento, JWT/gating.
Sobe independente no Coolify.
