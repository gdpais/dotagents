#!/bin/sh
# Builds the review fixtures as git repos under $1/fixtures (idempotent; never stored, G-33).
# Each repo is checked out on a feature branch whose diff against main plants the defects listed in
# review_key.json (file, line, kind). rv-clean plants none: any finding there is a false positive.
set -e
OUT="${1:-.}/fixtures"
mkdir -p "$OUT"
cd "$OUT"
rm -rf rv-billing rv-inventory rv-notifier rv-auth rv-clean rv-ledger rv-cache
export GIT_AUTHOR_NAME=dev GIT_AUTHOR_EMAIL=dev@example.invalid GIT_COMMITTER_NAME=dev GIT_COMMITTER_EMAIL=dev@example.invalid
export GIT_AUTHOR_DATE="2026-10-20T10:00:00Z" GIT_COMMITTER_DATE="2026-10-20T10:00:00Z"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
commit() { git add -A && git commit -q -m "$1"; }
init() { mkdir "$1" && cd "$1" && git -c init.defaultBranch=main init -q; }

# ---------- rv-billing (Python): tenant scoping, SQL injection, N+1, rounding ----------
init rv-billing
mkdir -p billing tests
cat > billing/__init__.py <<'X'
X
cat > billing/invoices.py <<'X'
"""Invoice queries. Every query is scoped to the caller's tenant."""
from dataclasses import dataclass


@dataclass
class Invoice:
    id: int
    tenant_id: int
    status: str
    total_cents: int


def get_invoice(db, tenant_id: int, invoice_id: int) -> Invoice | None:
    row = db.execute(
        "SELECT id, tenant_id, status, total_cents FROM invoices WHERE id = ? AND tenant_id = ?",
        (invoice_id, tenant_id),
    ).fetchone()
    return Invoice(*row) if row else None


def search_invoices(db, tenant_id: int, status: str) -> list[Invoice]:
    rows = db.execute(
        "SELECT id, tenant_id, status, total_cents FROM invoices WHERE tenant_id = ? AND status = ?",
        (tenant_id, status),
    ).fetchall()
    return [Invoice(*r) for r in rows]
X
cat > billing/pricing.py <<'X'
"""Order totals in integer cents."""
from dataclasses import dataclass


@dataclass
class Line:
    product_id: int
    qty: int


def load_prices(db, product_ids: list[int]) -> dict[int, int]:
    marks = ",".join("?" for _ in product_ids)
    rows = db.execute(f"SELECT id, price_cents FROM products WHERE id IN ({marks})", product_ids).fetchall()
    return {pid: price for pid, price in rows}


def order_total(db, lines: list[Line], discount: float = 0.0) -> int:
    prices = load_prices(db, [l.product_id for l in lines])
    total = 0
    for line in lines:
        total += round(prices[line.product_id] * line.qty * (1 - discount))
    return total
X
cat > tests/test_pricing.py <<'X'
import sqlite3
import unittest

from billing.pricing import Line, order_total


class OrderTotal(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("CREATE TABLE products (id INTEGER PRIMARY KEY, price_cents INTEGER)")
        self.db.executemany("INSERT INTO products VALUES (?, ?)", [(1, 999), (2, 250)])

    def test_no_discount(self):
        self.assertEqual(order_total(self.db, [Line(1, 2), Line(2, 1)]), 2248)


if __name__ == "__main__":
    unittest.main()
X
commit "feat: invoices and pricing"
git checkout -q -b feature/pricing-refactor
cat > billing/invoices.py <<'X'
"""Invoice queries. Every query is scoped to the caller's tenant."""
from dataclasses import dataclass

COLUMNS = "id, tenant_id, status, total_cents"


@dataclass
class Invoice:
    id: int
    tenant_id: int
    status: str
    total_cents: int


def get_invoice(db, tenant_id: int, invoice_id: int) -> Invoice | None:
    row = db.execute(f"SELECT {COLUMNS} FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    return Invoice(*row) if row else None


def search_invoices(db, tenant_id: int, status: str) -> list[Invoice]:
    query = f"SELECT {COLUMNS} FROM invoices WHERE tenant_id = ? AND status = '{status}'"
    return [Invoice(*r) for r in db.execute(query, (tenant_id,)).fetchall()]
X
cat > billing/pricing.py <<'X'
"""Order totals in integer cents."""
from dataclasses import dataclass


@dataclass
class Line:
    product_id: int
    qty: int


def price_of(db, product_id: int) -> int:
    row = db.execute("SELECT price_cents FROM products WHERE id = ?", (product_id,)).fetchone()
    return row[0]


def order_total(db, lines: list[Line], discount: float = 0.0) -> int:
    """Sum the lines first, then apply the discount once to the whole order."""
    subtotal = 0
    for line in lines:
        subtotal += price_of(db, line.product_id) * line.qty
    return int(subtotal * (1 - discount))
X
commit "refactor(pricing): simpler totals and shared invoice columns"
cd ..

# ---------- rv-inventory (TypeScript): check-then-act race, swallowed capture failure ----------
init rv-inventory
mkdir -p src test
cat > package.json <<'X'
{ "name": "inventory", "private": true, "scripts": { "test": "bun test" } }
X
cat > src/repo.ts <<'X'
// Stock repository over the inventory database.
export interface Item { sku: string; available: number }
export interface Repo {
  get(sku: string): Promise<Item>;
  update(sku: string, patch: Partial<Item>): Promise<void>;
  /** Atomic: UPDATE items SET available = available - qty WHERE sku = ? AND available >= qty. */
  decrementIfAvailable(sku: string, qty: number): Promise<boolean>;
}
export interface Payments { capture(orderId: string, cents: number): Promise<{ id: string }> }
export interface Orders { markPaid(orderId: string, captureId: string): Promise<void>; markFailed(orderId: string, reason: string): Promise<void> }
X
cat > src/reservations.ts <<'X'
import type { Orders, Payments, Repo } from "./repo";

export class OutOfStock extends Error {}

export async function reserve(repo: Repo, sku: string, qty: number): Promise<void> {
  if (qty <= 0) throw new RangeError("qty must be positive");
  const ok = await repo.decrementIfAvailable(sku, qty);
  if (!ok) throw new OutOfStock(sku);
}

export async function confirmOrder(payments: Payments, orders: Orders, orderId: string, cents: number): Promise<void> {
  try {
    const capture = await payments.capture(orderId, cents);
    await orders.markPaid(orderId, capture.id);
  } catch (err) {
    await orders.markFailed(orderId, String(err));
    throw err;
  }
}
X
cat > test/reservations.test.ts <<'X'
import { expect, test } from "bun:test";
import { reserve } from "../src/reservations";

test("rejects non-positive qty", async () => {
  await expect(reserve({} as any, "a", 0)).rejects.toThrow();
});
X
commit "feat: reservations"
git checkout -q -b feature/reservations-audit
cat > src/audit.ts <<'X'
export interface Audit { record(event: string, data: Record<string, unknown>): Promise<void> }
X
cat > src/reservations.ts <<'X'
import type { Audit } from "./audit";
import type { Orders, Payments, Repo } from "./repo";

export class OutOfStock extends Error {}

/** Reserve stock and leave an audit trail of the level before and after. */
export async function reserve(repo: Repo, audit: Audit, sku: string, qty: number): Promise<void> {
  if (qty <= 0) throw new RangeError("qty must be positive");
  const item = await repo.get(sku);
  if (item.available < qty) throw new OutOfStock(sku);
  await audit.record("reserve", { sku, qty, before: item.available });
  await repo.update(sku, { available: item.available - qty });
}

export async function confirmOrder(payments: Payments, orders: Orders, audit: Audit, orderId: string, cents: number): Promise<void> {
  let captureId = "pending";
  try {
    const capture = await payments.capture(orderId, cents);
    captureId = capture.id;
  } catch (err) {
    await audit.record("capture_error", { orderId, err: String(err) });
  }
  await orders.markPaid(orderId, captureId);
  await audit.record("confirmed", { orderId, captureId });
}
X
cat > test/reservations.test.ts <<'X'
import { expect, test } from "bun:test";
import { reserve } from "../src/reservations";

test("rejects non-positive qty", async () => {
  await expect(reserve({} as any, {} as any, "a", 0)).rejects.toThrow();
});
X
commit "feat(reservations): audit trail for stock and payments"
cd ..

# ---------- rv-notifier (TypeScript): unawaited async forEach, retry that never advances, leaked connection ----------
init rv-notifier
mkdir -p src
cat > package.json <<'X'
{ "name": "notifier", "private": true, "scripts": { "test": "bun test" } }
X
cat > src/deps.ts <<'X'
export interface Client { post(path: string, body: unknown): Promise<{ status: number }> }
export interface Conn { query(sql: string, params?: unknown[]): Promise<{ id: string; email: string }[]>; release(): void }
export interface Pool { connect(): Promise<Conn> }
export class HttpError extends Error { constructor(public status: number) { super(`HTTP ${status}`); } }
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
X
cat > src/send.ts <<'X'
import { type Client, HttpError, sleep } from "./deps";

const MAX_ATTEMPTS = 4;

export async function sendOne(client: Client, email: string, template: string) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await client.post("/messages", { to: email, template });
    } catch (err) {
      const retryable = !(err instanceof HttpError) || err.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      await sleep(200 * 2 ** attempt);
    }
  }
}
X
cat > src/batch.ts <<'X'
import type { Client, Pool } from "./deps";
import { sendOne } from "./send";

export async function sendCampaign(pool: Pool, client: Client, campaignId: string, template: string) {
  const conn = await pool.connect();
  try {
    const recipients = await conn.query("SELECT id, email FROM recipients WHERE campaign_id = $1", [campaignId]);
    let sent = 0;
    for (const r of recipients) {
      await sendOne(client, r.email, template);
      sent++;
    }
    return { sent };
  } finally {
    conn.release();
  }
}
X
commit "feat: campaign sending"
git checkout -q -b feature/batch-send
cat > src/send.ts <<'X'
import { type Client, HttpError, sleep } from "./deps";

const MAX_ATTEMPTS = 4;
const isRetryable = (err: unknown) => !(err instanceof HttpError) || err.status >= 500 || err.status === 429;

export async function sendOne(client: Client, email: string, template: string) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; ) {
    try {
      return await client.post("/messages", { to: email, template });
    } catch (err) {
      if (!isRetryable(err)) throw err;
      await sleep(200 * 2 ** attempt);
    }
  }
}
X
cat > src/batch.ts <<'X'
import type { Client, Pool } from "./deps";
import { sendOne } from "./send";

/** Send in parallel: campaigns are large and each send is independent. */
export async function sendCampaign(pool: Pool, client: Client, campaignId: string, template: string) {
  const conn = await pool.connect();
  const recipients = await conn.query("SELECT id, email FROM recipients WHERE campaign_id = $1", [campaignId]);
  conn.release();
  recipients.forEach(async (r) => {
    await sendOne(client, r.email, template);
  });
  return { sent: recipients.length };
}
X
commit "feat(batch): parallel campaign sends, retry 429"
cd ..

# ---------- rv-auth (TypeScript): open redirect, skippable state check, token in logs ----------
init rv-auth
mkdir -p src
cat > package.json <<'X'
{ "name": "auth", "private": true, "scripts": { "test": "bun test" } }
X
cat > src/http.ts <<'X'
export interface Req { query: Record<string, string | undefined>; session: { state?: string; userId?: string } }
export interface Res { redirect(url: string): void; status(code: number): Res; send(body: string): void }
export interface Idp { exchange(code: string): Promise<{ email: string; accessToken: string }> }
export const logger = { info: (msg: string, data?: unknown) => console.log(msg, JSON.stringify(data ?? {})) };
export const findOrCreateUser = async (email: string) => ({ id: `u_${email}` });
X
cat > src/sso.ts <<'X'
import { type Idp, logger, findOrCreateUser, type Req, type Res } from "./http";

const SAFE_RETURN = /^\/(?!\/)/; // same-site paths only

export async function ssoCallback(idp: Idp, req: Req, res: Res) {
  if (!req.query.state || req.query.state !== req.session.state) return res.status(400).send("bad state");
  const { email } = await idp.exchange(req.query.code ?? "");
  const user = await findOrCreateUser(email);
  req.session.userId = user.id;
  logger.info("sso login", { email });
  const returnTo = req.query.returnTo ?? "/";
  res.redirect(SAFE_RETURN.test(returnTo) ? returnTo : "/");
}
X
commit "feat: SSO callback"
git checkout -q -b feature/sso-callback
cat > src/sso.ts <<'X'
import { type Idp, logger, findOrCreateUser, type Req, type Res } from "./http";

/** SSO callback. Supports deep links from the marketing site via ?returnTo=. */
export async function ssoCallback(idp: Idp, req: Req, res: Res) {
  if (req.query.state && req.query.state !== req.session.state) return res.status(400).send("bad state");
  const { email, accessToken } = await idp.exchange(req.query.code ?? "");
  const user = await findOrCreateUser(email);
  req.session.userId = user.id;
  delete req.session.state;
  logger.info("sso login", { email, accessToken });
  res.redirect(req.query.returnTo ?? "/");
}
X
commit "feat(sso): deep links via returnTo, clear state after use"
cd ..

# ---------- rv-clean (TypeScript): behaviour-preserving refactor, no defects ----------
init rv-clean
mkdir -p src test
cat > package.json <<'X'
{ "name": "orders", "private": true, "scripts": { "test": "bun test" } }
X
cat > src/orders.ts <<'X'
export interface Order { id: string; totalCents: number; currency: "EUR" | "USD"; createdAt: Date }

export function formatCurrency(cents: number, currency: "EUR" | "USD"): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(cents / 100);
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function orderSummary(o: Order): string {
  return `${o.id} · ${formatDate(o.createdAt)} · ${formatCurrency(o.totalCents, o.currency)}`;
}
X
cat > test/orders.test.ts <<'X'
import { expect, test } from "bun:test";
import { orderSummary } from "../src/orders";

test("summary", () => {
  expect(orderSummary({ id: "o1", totalCents: 1234, currency: "EUR", createdAt: new Date("2026-10-01T12:00:00Z") })).toBe("o1 · 2026-10-01 · €12.34");
});
X
commit "feat: order summaries"
git checkout -q -b refactor/extract-formatters
cat > src/format.ts <<'X'
export type Currency = "EUR" | "USD";

export function formatCurrency(cents: number, currency: Currency): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(cents / 100);
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
X
cat > src/orders.ts <<'X'
import { type Currency, formatCurrency, formatDate } from "./format";

export { formatCurrency, formatDate } from "./format";

export interface Order { id: string; totalCents: number; currency: Currency; createdAt: Date }

export function orderSummary(o: Order): string {
  return `${o.id} · ${formatDate(o.createdAt)} · ${formatCurrency(o.totalCents, o.currency)}`;
}
X
cat > test/format.test.ts <<'X'
import { expect, test } from "bun:test";
import { formatCurrency, formatDate } from "../src/format";

test("currency", () => {
  expect(formatCurrency(1234, "EUR")).toBe("€12.34");
  expect(formatCurrency(5, "USD")).toBe("US$0.05");
});

test("date", () => {
  expect(formatDate(new Date("2026-10-01T23:30:00Z"))).toBe("2026-10-01");
});
X
commit "refactor: move formatters to format.ts, add tests"
cd ..
# ---------- rv-ledger (Python, harder): 1-based page offset, split transactions, mutable default ----------
init rv-ledger
mkdir -p ledger
cat > ledger/__init__.py <<'X'
X
cat > ledger/entries.py <<'X'
"""Ledger entries. Amounts are Decimal; pages are 1-based."""
from decimal import Decimal


def to_amount(value) -> Decimal:
    # str() first so floats from JSON don't carry binary noise into the ledger.
    return Decimal(str(value)).quantize(Decimal("0.01"))


def list_entries(db, account_id: int, page: int = 1, size: int = 50):
    """Entries for an account, newest first. `page` starts at 1."""
    offset = (page - 1) * size
    return db.execute(
        "SELECT id, amount, memo FROM entries WHERE account_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        (account_id, size, offset),
    ).fetchall()


def post(db, account_id: int, amount, memo: str, tags: list[str] | None = None) -> int:
    tags = list(tags or [])
    cur = db.execute("INSERT INTO entries (account_id, amount, memo, tags) VALUES (?, ?, ?, ?)",
                     (account_id, str(to_amount(amount)), memo, ",".join(tags)))
    return cur.lastrowid


def transfer(db, src: int, dst: int, amount, memo: str) -> None:
    """Move money between accounts atomically."""
    with db:
        post(db, src, -to_amount(amount), memo)
        post(db, dst, to_amount(amount), memo)
X
commit "feat: ledger entries and transfers"
git checkout -q -b feature/transfer-fees
cat > ledger/entries.py <<'X'
"""Ledger entries. Amounts are Decimal; pages are 1-based."""
from decimal import Decimal

FEE_RATE = Decimal("0.005")


def to_amount(value) -> Decimal:
    # str() first so floats from JSON don't carry binary noise into the ledger.
    return Decimal(str(value)).quantize(Decimal("0.01"))


def list_entries(db, account_id: int, page: int = 1, size: int = 50):
    """Entries for an account, newest first. `page` starts at 1."""
    return db.execute(
        "SELECT id, amount, memo FROM entries WHERE account_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        (account_id, size, page * size),
    ).fetchall()


def post(db, account_id: int, amount, memo: str, tags: list[str] = []) -> int:
    if memo.startswith("fee:"):
        tags.append("fee")
    cur = db.execute("INSERT INTO entries (account_id, amount, memo, tags) VALUES (?, ?, ?, ?)",
                     (account_id, str(to_amount(amount)), memo, ",".join(tags)))
    return cur.lastrowid


def transfer(db, src: int, dst: int, amount, memo: str, fee_account: int) -> None:
    """Move money between accounts and charge the transfer fee."""
    amount = to_amount(amount)
    fee = (amount * FEE_RATE).quantize(Decimal("0.01"))
    with db:
        post(db, src, -(amount + fee), memo)
    with db:
        post(db, dst, amount, memo)
        post(db, fee_account, fee, f"fee:{memo}")
X
commit "feat(transfers): charge a 0.5% fee"
cd ..

# ---------- rv-cache (TypeScript, harder): per-user page cached by path, TTL in the wrong unit, errors cached ----------
init rv-cache
mkdir -p src
cat > package.json <<'X'
{ "name": "dashboard", "private": true, "scripts": { "test": "bun test" } }
X
cat > src/deps.ts <<'X'
export interface Req { path: string; userId: string; query: Record<string, string | undefined> }
export interface Upstream { status: number; body: string }
export interface Cache {
  get(key: string): Promise<Upstream | undefined>;
  /** ttlMs: time to live in milliseconds. */
  set(key: string, value: Upstream, ttlMs: number): Promise<void>;
}
export interface Api { dashboard(userId: string): Promise<Upstream>; widgets(ids: string[]): Promise<Upstream[]> }
X
cat > src/dashboard.ts <<'X'
import type { Api, Req, Upstream } from "./deps";

/** The signed-in user's dashboard (personal balances and alerts). */
export async function dashboard(api: Api, req: Req): Promise<Upstream> {
  return api.dashboard(req.userId);
}
X
commit "feat: dashboard endpoint"
git checkout -q -b feature/dashboard-cache
cat > src/dashboard.ts <<'X'
import type { Api, Cache, Req, Upstream } from "./deps";

const TTL_SECONDS = 300;

/** The signed-in user's dashboard (personal balances and alerts), cached for five minutes. */
export async function dashboard(api: Api, cache: Cache, req: Req): Promise<Upstream> {
  const key = `dashboard:${req.path}`;
  const hit = await cache.get(key);
  if (hit) return hit;
  const res = await api.dashboard(req.userId);
  await cache.set(key, res, TTL_SECONDS);
  return res;
}

/** Widgets are public and fetched together to avoid one round trip per widget. */
export async function widgets(api: Api, ids: string[]): Promise<Upstream[]> {
  return ids.length ? api.widgets([...new Set(ids)]) : [];
}
X
commit "perf(dashboard): cache the dashboard for five minutes"
cd ..
echo "review fixtures in $OUT"
