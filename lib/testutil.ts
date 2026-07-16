import postgres from "postgres"
import { randomUUID } from "node:crypto"
import { applyTenantMigrations, schemaName } from "@/lib/platform/tenancy"
import { tenantMigrations } from "@/lib/db/migrations"
import type { Sql } from "@/lib/db"

// Sobe o subconjunto do control plane (que o core é dono) + trigger de agregação de
// uso, e provisiona schemas de tenant, para testar o Motor de ponta a ponta contra
// um Postgres. Espelha margot/internal/testutil.

export function testSql(): Sql {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error("TEST_DATABASE_URL não definida")
  return postgres(url, { prepare: false, max: 4 })
}

const CONTROL_PLANE = `
DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
DROP SCHEMA IF EXISTS bus CASCADE;
CREATE SCHEMA IF NOT EXISTS bus;
CREATE TABLE IF NOT EXISTS public.subscriptions (
  tenant_id uuid NOT NULL, produto text NOT NULL, tier text NOT NULL,
  status text NOT NULL DEFAULT 'active', hard_cap boolean NOT NULL DEFAULT false,
  activated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, produto));
CREATE TABLE IF NOT EXISTS public.plans (
  produto text NOT NULL, tier text NOT NULL, metric text, mensal numeric(12,2),
  incluso int, canais int, excedente_unitario numeric(12,2), piso numeric(12,2),
  PRIMARY KEY (produto, tier));
CREATE TABLE IF NOT EXISTS public.product_rules (produto text PRIMARY KEY, rules jsonb NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS public.usage_counters (
  tenant_id uuid NOT NULL, produto text NOT NULL, period text NOT NULL, metric text NOT NULL,
  count integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, produto, period, metric));
CREATE TABLE IF NOT EXISTS public.event_outbox (
  id bigserial PRIMARY KEY, type text NOT NULL, tenant_id uuid NOT NULL, produto text,
  payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS bus.event_cursors (
  consumer text PRIMARY KEY, last_id bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION aggregate_usage_recorded() RETURNS trigger AS $$
DECLARE v_metric text; v_period text; v_count int;
BEGIN
  IF NEW.type <> 'UsageRecorded' THEN RETURN NEW; END IF;
  v_metric := NEW.payload->>'metric'; v_period := NEW.payload->>'period';
  v_count := COALESCE((NEW.payload->>'count')::int, 0);
  IF NEW.produto IS NULL OR v_metric IS NULL OR v_period IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.usage_counters (tenant_id, produto, period, metric, count)
  VALUES (NEW.tenant_id, NEW.produto, v_period, v_metric, v_count)
  ON CONFLICT (tenant_id, produto, period, metric)
  DO UPDATE SET count = public.usage_counters.count + EXCLUDED.count, updated_at = now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS event_outbox_aggregate_usage ON public.event_outbox;
CREATE TRIGGER event_outbox_aggregate_usage AFTER INSERT ON public.event_outbox
  FOR EACH ROW EXECUTE FUNCTION aggregate_usage_recorded();
TRUNCATE public.subscriptions, public.plans, public.product_rules, public.usage_counters,
         public.event_outbox, bus.event_cursors;
INSERT INTO public.product_rules (produto, rules)
  VALUES ('motor', '{"janela_aprovacao_horas": 48, "max_regeneracoes_por_peca": 2}');
INSERT INTO public.plans (produto, tier, metric, mensal, incluso, canais, excedente_unitario)
  VALUES ('motor','start','peca',400,12,1,25),
         ('motor','pro','peca',700,30,2,25),
         ('motor','scale','peca',1200,60,3,25);
`

export async function setupControlPlane(sql: Sql): Promise<void> {
  await sql.unsafe(CONTROL_PLANE)
  await dropTenants(sql)
}

/** Cria tenant_<id>, aplica migrations do Motor e semeia uma assinatura motor ativa. */
export async function provisionTenant(sql: Sql, tier: "start" | "pro" | "scale" = "pro"): Promise<string> {
  const tid = randomUUID()
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName(tid)}"`)
  await applyTenantMigrations(sql, tid, tenantMigrations())
  await sql`
    INSERT INTO public.subscriptions (tenant_id, produto, tier, status)
    VALUES (${tid}::uuid, 'motor', ${tier}, 'active')
    ON CONFLICT (tenant_id, produto) DO UPDATE SET tier = EXCLUDED.tier, status = 'active'
  `
  return tid
}

export async function dropTenants(sql: Sql): Promise<void> {
  const rows = (await sql`
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%' ESCAPE '\\'
  `) as unknown as { nspname: string }[]
  for (const r of rows) await sql.unsafe(`DROP SCHEMA IF EXISTS "${r.nspname}" CASCADE`)
}

/** Uso agregado (usage_counters) de uma métrica no período corrente. */
export async function usage(sql: Sql, tenantId: string, metric: string): Promise<number> {
  const period = new Date().toISOString().slice(0, 7)
  const rows = (await sql`
    SELECT count FROM public.usage_counters
    WHERE tenant_id = ${tenantId}::uuid AND produto = 'motor' AND period = ${period} AND metric = ${metric}
  `) as unknown as { count: number }[]
  return rows[0]?.count ?? 0
}
