#!/usr/bin/env bash
# Verificação end-to-end VIVA do PROMPT B: core (dono do public) + Motor sobre o
# MESMO Postgres, exercendo o boundary real (HTTP + JWT + outbox). Prova:
#   - provisioning: core.activateSubscription → outbox → Motor catch-up aplica migrations
#   - billing: publicar → 1 UsageRecorded{peca} → trigger do core agrega usage_counters;
#     republicar NÃO refatura (guard published_at) nem duplica social_drafts (idempotente)
#   - isolamento: tenant B não enxerga o conteúdo de A
#   - auth: sem token → 401
#
# Requisitos: um Postgres acessível e o repo do core em ../sapienza-core.
# Uso:  DATABASE_URL=postgres://user:pass@host:5432/db  bash scripts/e2e.sh
set -euo pipefail

MOTOR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CORE_DIR="${CORE_DIR:-$(cd "$MOTOR_DIR/../sapienza-core" && pwd)}"
DB="${DATABASE_URL:?defina DATABASE_URL apontando para o Postgres compartilhado}"
export DATABASE_URL="$DB"
export PRODUCT_JWT_SECRET="${PRODUCT_JWT_SECRET:-e2e-shared-secret}"
export MOTOR_ENC_KEY="${MOTOR_ENC_KEY:-$(head -c32 /dev/zero | base64)}"
export WEBHOOK_SECRET="${WEBHOOK_SECRET:-e2e-cron-secret}"
PORT="${PORT:-3100}"
BASE="http://localhost:${PORT}"
PSQL=(psql "$DB" -tA)

TA="$(cat /proc/sys/kernel/random/uuid)"
TB="$(cat /proc/sys/kernel/random/uuid)"
echo "tenant A=$TA  B=$TB"

echo "== core: migrate + pricing:sync =="
( cd "$CORE_DIR" && pnpm db:migrate && pnpm pricing:sync )

echo "== core: cria tenants + ativa assinatura motor/pro (caminho real) =="
"${PSQL[@]}" -c "INSERT INTO public.tenants (id,name,slug) VALUES ('$TA','Tenant A','e2e-a-$RANDOM'),('$TB','Tenant B','e2e-b-$RANDOM') ON CONFLICT (id) DO NOTHING;"
( cd "$CORE_DIR" && pnpm exec tsx scripts/e2e-activate.ts "$TA" "$TB" --produto motor --tier pro )

echo "== motor: provision (catch-up aplica migrations de tenant) =="
( cd "$MOTOR_DIR" && pnpm provision )

echo "== motor: build + start em :$PORT =="
( cd "$MOTOR_DIR" && pnpm build >/dev/null )
( cd "$MOTOR_DIR" && pnpm start -p "$PORT" >/tmp/motor-e2e.log 2>&1 & echo $! >/tmp/motor-e2e.pid )
trap 'kill "$(cat /tmp/motor-e2e.pid)" 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/content")" = "401" ] && break
  sleep 1
done

JWTA="$(cd "$MOTOR_DIR" && pnpm exec tsx scripts/e2e-mint.ts "$TA")"
JWTB="$(cd "$MOTOR_DIR" && pnpm exec tsx scripts/e2e-mint.ts "$TB")"

echo "== fluxo: A conecta canal, cria e publica (2x) =="
curl -sf -X POST "$BASE/api/v1/channels" -H "authorization: Bearer $JWTA" -H 'content-type: application/json' -d '{"platform":"blog"}' >/dev/null
ID="$(curl -sf -X POST "$BASE/api/v1/content" -H "authorization: Bearer $JWTA" -H 'content-type: application/json' -d '{"prompt":"peça e2e"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
curl -sf -X POST "$BASE/api/v1/content/$ID/publish" -H "authorization: Bearer $JWTA" -d '{}' >/dev/null
curl -sf -X POST "$BASE/api/v1/content/$ID/publish" -H "authorization: Bearer $JWTA" -d '{}' >/dev/null

fail() { echo "FALHOU: $1"; exit 1; }
PERIOD="$(date +%Y-%m)"
USAGE_A="$("${PSQL[@]}" -c "SELECT COALESCE(count,0) FROM public.usage_counters WHERE tenant_id='$TA' AND produto='motor' AND period='$PERIOD' AND metric='peca';")"
[ "${USAGE_A:-0}" = "1" ] || fail "billing A esperado 1, obtido '${USAGE_A:-0}'"
DRAFTS="$("${PSQL[@]}" -c "SELECT count(*) FROM \"tenant_${TA//-/}\".social_drafts WHERE content_item_id='$ID';")"
[ "$DRAFTS" = "1" ] || fail "social_drafts esperado 1 (idempotente), obtido '$DRAFTS'"
ITEMS_B="$(curl -sf "$BASE/api/v1/content" -H "authorization: Bearer $JWTB")"
[ "$ITEMS_B" = '{"items":[]}' ] || fail "isolamento: B enxergou conteúdo: $ITEMS_B"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/content")"
[ "$CODE" = "401" ] || fail "sem token esperado 401, obtido $CODE"

echo "OK — billing=1, idempotente, isolado, auth 401. e2e verde."
