#!/bin/sh
# Builds the routing-test fixtures under $1/fixtures (default ./fixtures). Idempotent; not stored (G-33).
#   billing-svc  git repo on feature/pricing-refactor (2 commits ahead of main: discount bug, SQL
#                concatenation + N+1 lookup) with an uncommitted change in src/invoice.ts, so
#                "review my branch" and "check my uncommitted changes" are real.
#   ops          incident evidence folder (inputs/): HAProxy and Grafana excerpts, change log,
#                on-call notes, a live incident doc and an INC-2219 folder (record, RCA, notes).
set -e
OUT="${1:-.}/fixtures"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$OUT"
export GIT_AUTHOR_NAME=dev GIT_AUTHOR_EMAIL=dev@example.invalid GIT_COMMITTER_NAME=dev GIT_COMMITTER_EMAIL=dev@example.invalid
export GIT_AUTHOR_DATE="2026-09-28T10:00:00Z" GIT_COMMITTER_DATE="2026-09-28T10:00:00Z"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
commit() { git add -A && git commit -q -m "$1"; }

# ---------- billing-svc ----------
mkdir billing-svc && cd billing-svc && git -c init.defaultBranch=main init -q
mkdir -p src test
cat > package.json <<'X'
{ "name": "billing-svc", "private": true, "scripts": { "test": "bun test" } }
X
cat > src/db.ts <<'X'
// Thin query helper over the orders database.
export interface Row { [k: string]: unknown }
export const db = {
  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (globalThis as any).__fakeDb?.(sql, params) ?? [];
  },
};
X
cat > src/pricing.ts <<'X'
import { db } from "./db";

export interface Line { sku: string; qty: number; unitCents: number; promo?: string }
export interface Promo { code: string; rate: number }

export async function loadPromo(code: string): Promise<Promo | undefined> {
  const [row] = await db.query("SELECT code, rate FROM promos WHERE code = $1", [code]);
  return row as Promo | undefined;
}

export function applyDiscount(cents: number, promo?: Promo): number {
  if (!promo) return cents;
  return Math.round(cents * (1 - promo.rate));
}

export async function calcTotal(lines: Line[], promo?: Promo): Promise<number> {
  let total = 0;
  for (const l of lines) total += l.qty * l.unitCents;
  return applyDiscount(total, promo);
}
X
cat > src/invoice.ts <<'X'
import { calcTotal, type Line } from "./pricing";

export interface Customer { id: string; name: string; email?: string }

export async function buildInvoice(customer: Customer, lines: Line[]) {
  const total = await calcTotal(lines);
  const to = customer.email ? customer.email.toLowerCase() : null;
  return { customerId: customer.id, to, totalCents: total, lines: lines.length };
}
X
cat > test/pricing.test.ts <<'X'
import { expect, test } from "bun:test";
import { applyDiscount, calcTotal } from "../src/pricing";

test("no promo", async () => {
  expect(await calcTotal([{ sku: "a", qty: 2, unitCents: 500 }])).toBe(1000);
});
test("10% promo", () => {
  expect(applyDiscount(1000, { code: "TEN", rate: 0.1 })).toBe(900);
});
X
commit "feat: pricing and invoices"
git checkout -q -b feature/pricing-refactor
cat > src/pricing.ts <<'X'
import { db } from "./db";

export interface Line { sku: string; qty: number; unitCents: number; promo?: string }
export interface Promo { code: string; rate: number }

export async function loadPromo(code: string): Promise<Promo | undefined> {
  const [row] = await db.query("SELECT code, rate FROM promos WHERE code = $1", [code]);
  return row as Promo | undefined;
}

export function applyDiscount(cents: number, promo?: Promo): number {
  if (!promo) return cents;
  return Math.round(cents * (1 - promo.rate));
}

// Per-line promos: each line can carry its own promo code; the cart-level promo applies on top.
export async function calcTotal(lines: Line[], promo?: Promo): Promise<number> {
  let total = 0;
  for (let i = 0; i <= lines.length - 1; i++) {
    const l = lines[i];
    const linePromo = l.promo ? await loadPromo(l.promo) : undefined;
    total += applyDiscount(l.qty * l.unitCents, linePromo ?? promo);
  }
  return applyDiscount(total, promo);
}
X
commit "refactor(pricing): per-line promos"
cat > src/customers.ts <<'X'
import { db } from "./db";

export async function findInvoicesByCustomer(name: string) {
  const customers = await db.query(`SELECT id FROM customers WHERE name LIKE '%${name}%'`);
  const out = [];
  for (const c of customers) {
    out.push(...(await db.query("SELECT * FROM invoices WHERE customer_id = $1", [c.id])));
  }
  return out;
}
X
commit "feat(customers): invoice search by customer name"
# Uncommitted: drops the missing-email guard.
cat > src/invoice.ts <<'X'
import { calcTotal, type Line } from "./pricing";

export interface Customer { id: string; name: string; email?: string }

export async function buildInvoice(customer: Customer, lines: Line[]) {
  const total = await calcTotal(lines);
  const to = customer.email!.toLowerCase();
  return { customerId: customer.id, to, totalCents: total, lines: lines.length, sentAt: Date.now() };
}
X
cd ..

# ---------- ops ----------
mkdir -p ops/inputs/inc-2219 ops/inputs/search && cd ops
cat > inputs/haproxy-edge-01.log <<'X'
Sep 30 12:40:58 edge-01 haproxy[812]: 10.0.4.11:50112 [30/Sep/2026:12:40:58.201] fe_https~ be_checkout/checkout-1 0/0/1/88/89 200 812 - - ---- 401/388/22/6/0 0/0 "POST /api/checkout HTTP/1.1"
Sep 30 12:41:07 edge-01 haproxy[812]: 10.0.4.17:51234 [30/Sep/2026:12:41:07.113] fe_https~ be_checkout/checkout-2 0/0/1/30001/30002 503 216 - - sH-- 412/398/37/9/0 0/0 "POST /api/checkout HTTP/1.1"
Sep 30 12:41:09 edge-01 haproxy[812]: 10.0.4.21:51290 [30/Sep/2026:12:41:09.402] fe_https~ be_checkout/checkout-1 0/0/1/30000/30001 503 216 - - sH-- 415/401/39/10/0 0/0 "POST /api/checkout HTTP/1.1"
Sep 30 13:19:40 edge-01 haproxy[812]: 10.0.4.30:52001 [30/Sep/2026:13:19:40.010] fe_https~ be_checkout/checkout-2 0/0/1/92/93 200 805 - - ---- 380/366/18/5/0 0/0 "POST /api/checkout HTTP/1.1"
X
cat > inputs/grafana-checkout.csv <<'X'
time,rps,error_rate,p95_ms,db_pool_in_use,db_pool_max
2026-09-30T12:30:00Z,410,0.002,180,9,10
2026-09-30T12:40:00Z,415,0.081,29800,10,10
2026-09-30T13:00:00Z,402,0.094,30000,10,10
2026-09-30T13:20:00Z,398,0.003,190,6,10
X
cat > inputs/changes.md <<'X'
# Change log
- 2026-09-30 11:55 CDN TLS certificate rotation (edge, all regions)
- 2026-09-30 12:32 checkout-svc v2.31: new promo lookup per cart line
- 2026-09-30 13:15 checkout-svc rolled back to v2.30
- 2026-10-01 10:40 reco-svc v3.4
X
cat > inputs/oncall-notes.md <<'X'
12:43 alert checkout 5xx > 5%. 12:50 Ana: CDN cert rotated at 11:55, could be TLS? 12:58 Rui: DB CPU 30%, pool at max.
13:10 decided rollback of v2.31. 13:15 rollback done. 13:20 errors back to baseline.
X
cat > inputs/inc-live.md <<'X'
# INC-2231 checkout 5xx (live)
Status: investigating. Impact: ~12% of POST /api/checkout failing on edge-01/edge-02 since 14:05.
Known: checkout-svc v2.31 deployed 13:58. Suspected: DB pool. Ruled out: payments provider (status green).
Next update: 14:45.
X
cat > inputs/inc-2219/record.md <<'X'
# INC-2219 payment confirmations failing
Start 2026-09-28 10:12, detected 10:19, mitigated 11:02 (fraud-svc config reverted), resolved 11:20.
SLO: 99.9% of payment confirmations succeed within 3s, 28-day window.
X
cat > inputs/inc-2219/rca-bruno.md <<'X'
# RCA (draft, Bruno)
Root cause: the orders DB failover at 10:05 caused connection resets; payments-gw retried and timed out.
Fix: failover finished, things recovered.
X
cat > inputs/inc-2219/rca-summary.md <<'X'
# RCA summary
Root cause (high confidence): fraud-svc client timeout lowered from 2s to 500ms in the Monday 09:50 config change;
payments-gw retries saturated its pool. DB failover at 10:05 completed in 14s and is not causal. Fixed by revert at 11:02.
X
cat > inputs/inc-2219/slack-notes.md <<'X'
10:19 alert. 10:25 "is it the DB failover?" 10:40 fraud-svc p95 900ms. 10:55 Marta: failover clean. 11:02 config reverted. 11:20 resolved.
X
cat > inputs/search/search-svc.log <<'X'
2026-10-01T11:02:13Z GET /search?q=boots 200 412ms
2026-10-01T11:14:40Z GET /search?q=jacket 504 30000ms
2026-10-01T11:15:02Z GET /search?q=socks 504 30000ms
X
cat > inputs/search/es-nodes.csv <<'X'
time,node,heap_pct,gc_old_ms,search_queue
2026-10-01T11:00:00Z,es-2,71,40,3
2026-10-01T11:15:00Z,es-2,97,8400,1180
X
cat > inputs/search/slack.md <<'X'
11:20 Tiago: it's the reco v3.4 deploy for sure. 11:35 restarted es-2, recovered 11:41.
X
cd ..
echo "fixtures in $OUT"
