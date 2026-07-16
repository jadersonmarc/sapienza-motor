# AGENTS.md — sapienza-motor

Convenções para agentes/dev no data plane Motor (conteúdo, TypeScript).

## Layout

```
sapienza-motor/
  lib/db.ts                 cliente postgres-js (lazy)
  lib/platform/             tenancy, gating, events, authclient, crypto (espelha o kit Go)
  db/migrations/tenant/     tabelas por tenant (aplicadas via applyTenantMigrations)
  lib/content/              state-machine, store, transition (billing), regenerate
  lib/channels/             Channel + blog/instagram/linkedin + MockChannel + registry
  lib/provisioning.ts       consumer do outbox (SubscriptionActivated{motor})
  lib/testutil.ts           control-plane subset + provisiona tenants (testes)
  app/                      (Fase 6+) API v1 + crons (route handlers)
```

## Regras

- **Isolamento por schema**: nunca `tenant_id` em query; sempre `withTenant` numa
  transação. Vazamento zero é aceite.
- **Escrita em public só via `events.ts`** (append no outbox). Leitura de `public`
  (gating/plans/product_rules) é read-only.
- **jsonb**: `${tx.json(obj)}` (postgres-js re-encoda `${JSON.stringify}::jsonb`).
- **Billing**: 1 `UsageRecorded{metric:"peca"}` na 1ª transição→published (guard
  `published_at`). Multi-canal = 1 peça.
- **Regras** (janela 48h, máx 2 regen, canais por tier) de `public.product_rules`/`plans`.
- **Auth API**: JWT do core via `verifyProductToken` (issuer sapienza-core).

## Testes

- Integração exige `TEST_DATABASE_URL`; sem ela, `describe.skip`. `pnpm test`.
- `testutil` sobe o `public` subset + trigger de agregação e provisiona 2 tenants.
  Cobrir isolamento, billing por peça, janela 48h, limite de regeneração, canais por tier,
  provisioning por evento. `MockChannel` captura publicações; Claude/R2 atrás de seams.
