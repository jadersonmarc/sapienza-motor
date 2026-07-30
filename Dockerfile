# sapienza-motor — imagem para Coolify. Um serviço Next.js; o Postgres é externo
# (o MESMO do core). No boot: catch-up de provisioning (migrations de tenant p/
# assinantes motor ativos) e depois sobe a API. As migrations do Motor vivem só nos
# schemas tenant_<id> — não há migration de `public` (é do core).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- deps + build ---
FROM base AS build
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile=false
COPY . .
# db.ts é lazy → build não precisa de DATABASE_URL.
RUN pnpm build

# --- runner ---
FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000

# Health check via Node (imagem slim não tem curl/wget). GET /health → 200 "ok".
# start-period folgado: o provision (catch-up + outbox) roda antes do next start.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# provision (catch-up + drena outbox) é idempotente; roda a cada boot antes do start.
CMD ["sh", "-lc", "pnpm provision && pnpm start"]
