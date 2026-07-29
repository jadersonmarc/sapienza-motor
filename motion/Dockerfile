# Serviço de render de MOTION (Remotion, render local). Base com as libs do Chromium
# headless (o @remotion/renderer baixa um Chromium compatível no 1º uso) + ffmpeg
# que o Remotion já traz. Requisito de memória: ≥ 2 GB (4 GB recomendado p/ 9:16).
#
# IMPORTANTE: o build context deve ser a RAIZ do repo do motor (motion/ importa
# ../lib e ../assets). No Coolify: Build Pack = Dockerfile, Dockerfile = motion/Dockerfile.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates fonts-liberation \
  libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
  libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 \
  libpango-1.0-0 libcairo2 libcups2 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
COPY . /app

WORKDIR /app/motion
RUN pnpm install --frozen-lockfile
# Copia as fontes da marca (../assets/fonts) para public/fonts (staticFile).
RUN pnpm copy-assets

ENV PORT=3200
EXPOSE 3200
# Sobe o worker HTTP: POST /trigger (x-webhook-secret) roda o scan; GET /health.
CMD ["pnpm", "render-worker"]
