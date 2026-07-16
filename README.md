# sapienza-motor

Data plane **Motor de Conteúdo** — geração, aprovação (janela 48h, silêncio = aprovado)
e publicação multi-canal (blog/Instagram/LinkedIn) de "peças", multi-tenant. Produto
**TypeScript** (Next.js) da plataforma Sapienza; **não** usa o kit Go — integra com o
`sapienza-core` por SQL no `public` + JWT do core. Faturamento por **peça publicada**.

## Stack

Next.js 16 · React 19 · postgres-js · jose · @anthropic-ai/sdk · next/og (Satori) ·
@aws-sdk/client-s3 (R2) · pnpm.

## Desenvolvimento

```bash
pnpm install
pnpm typecheck
export TEST_DATABASE_URL=postgres://...   # p/ testes de integração
pnpm test
```

## Execução

Envs: `DATABASE_URL`, `PRODUCT_JWT_SECRET`, `MOTOR_ENC_KEY`, `ANTHROPIC_API_KEY`,
`INSTAGRAM_*`, `LINKEDIN_*`, R2/`S3_*`, `WEBHOOK_SECRET`. Sobe independente do core no
Coolify (mesmo Postgres). Ver `SPEC.md`, `CLAUDE.md`, `AGENTS.md` e `../INVENTORY.md`.
