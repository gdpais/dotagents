#!/bin/sh
# Builds the delivery eval fixtures as git repos under $1/fixtures (default ./fixtures). Idempotent.
# Planted problems are listed next to each fixture. Fixtures are regenerated, never stored (G-33).
set -e
OUT="${1:-.}/fixtures"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$OUT"
export GIT_AUTHOR_NAME=dev GIT_AUTHOR_EMAIL=dev@example.invalid GIT_COMMITTER_NAME=dev GIT_COMMITTER_EMAIL=dev@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
g() { git -c init.defaultBranch=main "$@"; }
# pkg NAME [EXTRA_SCRIPTS_JSON]: valid package.json via bun so escaping is never an issue
pkg() { bun -e "const [n, x] = process.argv.slice(1); console.log(JSON.stringify({ name: n, private: true, packageManager: 'bun@1.4.2', scripts: { test: 'bun test', ...(x ? JSON.parse(x) : {}) } }, null, 2))" "$1" "$2" > package.json; }
commit() { git add -A && git commit -q -m "$1" ${2:+-m "$2"}; }

# ---------- notify: typo (impl-typo) ----------
mkdir notify && cd notify && g init -q
mkdir -p src/notifications tests && pkg notify
cat > src/notifications/email.ts <<'X'
export function receiptEmail(name: string, total: string) {
  return { subject: "Your receipt", body: `Hi ${name}, you will recieve your receipt for ${total} shortly.` };
}
X
cat > tests/email.test.ts <<'X'
import { expect, test } from "bun:test";
import { receiptEmail } from "../src/notifications/email";
test("mentions total", () => { expect(receiptEmail("Ana", "€10").body).toContain("€10"); });
X
commit "feat: receipt email"
cd ..

# ---------- cart: discount feature, empty-cart bug (main); N+1 refactor (refactor/pricing) ----------
mkdir cart && cd cart && g init -q
mkdir -p src/cart src/db bench tests && pkg cart '{"bench:cart":"bun bench/cart.ts"}'
cat > src/db/fake.ts <<'X'
// Simulated database: each round trip costs time, like a real network hop.
export interface Promo { id: string; pct: number }
const PROMOS: Record<string, Promo> = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${i}`, { id: `p${i}`, pct: (i % 5) * 5 }]));
export const db = {
  promos: {
    findOne(id: string): Promo | undefined { Bun.sleepSync(1); return PROMOS[id]; },
    findMany(ids: string[]): Promo[] { Bun.sleepSync(3); return ids.map((id) => PROMOS[id]).filter(Boolean); },
  },
};
X
cat > src/cart/pricing.ts <<'X'
import { db } from "../db/fake";
export interface Item { sku: string; price: number; qty: number; promoId?: string }
export function cartTotal(items: Item[]): number {
  const promos = new Map(db.promos.findMany(items.flatMap((i) => (i.promoId ? [i.promoId] : []))).map((p) => [p.id, p]));
  let total = 0;
  for (const item of items) {
    const pct = item.promoId ? promos.get(item.promoId)?.pct ?? 0 : 0;
    total += item.price * item.qty * (1 - pct / 100);
  }
  return Math.round(total * 100) / 100;
}
X
cat > src/cart/stats.ts <<'X'
import type { Item } from "./pricing";
/** Average price per unit across the cart, rounded to cents. */
export function averageItemPrice(items: Item[]): number {
  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const units = items.reduce((sum, i) => sum + i.qty, 0);
  return Math.round((total / units) * 100) / 100;
}
X
cat > bench/cart.ts <<'X'
import { cartTotal } from "../src/cart/pricing";
const cart = Array.from({ length: 40 }, (_, i) => ({ sku: `s${i}`, price: 10 + i, qty: 1 + (i % 3), promoId: `p${i}` }));
cartTotal(cart);
X
cat > tests/pricing.test.ts <<'X'
import { expect, test } from "bun:test";
import { cartTotal } from "../src/cart/pricing";
test("applies promos", () => { expect(cartTotal([{ sku: "a", price: 100, qty: 1, promoId: "p1" }])).toBe(95); });
X
cat > tests/stats.test.ts <<'X'
import { expect, test } from "bun:test";
import { averageItemPrice } from "../src/cart/stats";
test("weighted by quantity", () => { expect(averageItemPrice([{ sku: "a", price: 10, qty: 3 }, { sku: "b", price: 30, qty: 1 }])).toBe(15); });
X
commit "feat: cart pricing and stats"
git checkout -q -b refactor/pricing
cat > src/cart/pricing.ts <<'X'
import { db } from "../db/fake";
export interface Item { sku: string; price: number; qty: number; promoId?: string }

function discountFor(item: Item): number {
  if (!item.promoId) return 0;
  const promo = db.promos.findOne(item.promoId);
  return promo ? promo.pct : 0;
}

function lineTotal(item: Item): number {
  return item.price * item.qty * (1 - discountFor(item) / 100);
}

export function cartTotal(items: Item[]): number {
  const total = items.reduce((sum, item) => sum + lineTotal(item), 0);
  return Math.round(total * 100) / 100;
}
X
commit "refactor(cart): split pricing into small functions"
git checkout -q main
cd ..

# ---------- auth: remember-me feature (main); insecure remember-me branch (feature/remember-me) ----------
mkdir auth && cd auth && g init -q
mkdir -p src/auth tests && pkg auth
cat > src/auth/session.ts <<'X'
import { randomBytes } from "node:crypto";
export interface Res { cookie(name: string, value: string, opts: Record<string, unknown>): void }
export interface Users { verify(email: string, password: string): Promise<{ id: string } | null> }
export async function login(users: Users, res: Res, email: string, password: string) {
  const user = await users.verify(email, password);
  if (!user) return { ok: false as const };
  const sid = randomBytes(32).toString("hex");
  res.cookie("sid", sid, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 60 * 60 * 1000 });
  return { ok: true as const, sid };
}
X
cat > tests/session.test.ts <<'X'
import { expect, test } from "bun:test";
import { login } from "../src/auth/session";
test("login sets a session cookie", async () => {
  const set: string[] = [];
  const r = await login({ verify: async () => ({ id: "u1" }) }, { cookie: (n) => set.push(n) }, "a@b.c", "pw");
  expect(r.ok).toBe(true);
  expect(set).toContain("sid");
});
X
commit "feat: login"
git checkout -q -b feature/remember-me
cat > src/auth/remember.ts <<'X'
import type { Res } from "./session";
export interface RememberStore { save(token: string, userId: string, expiresAt: number): Promise<void> }
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
export function newRememberToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
export async function rememberMe(store: RememberStore, res: Res, userId: string) {
  const token = newRememberToken();
  await store.save(token, userId, Date.now() + THIRTY_DAYS);
  res.cookie("remember_token", token, { maxAge: THIRTY_DAYS });
  return token;
}
X
cat > tests/remember.test.ts <<'X'
import { expect, test } from "bun:test";
import { rememberMe } from "../src/auth/remember";
test("remember me sets a cookie", async () => {
  const names: string[] = [];
  await rememberMe({ save: async () => {} }, { cookie: (n) => names.push(n) }, "u1");
  expect(names).toEqual(["remember_token"]);
});
X
commit "feat(auth): remember me on login"
git checkout -q main
cd ..

# ---------- pipelines: CI audit (pull_request_target + head checkout, script injection, @main, unprotected deploy, no scans) ----------
mkdir pipelines && cd pipelines && g init -q
mkdir -p .github/workflows && pkg pipelines '{"lint":"eslint .","build":"tsc -p ."}'
cat > .github/workflows/ci.yml <<'X'
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run lint
      - run: bun test
X
cat > .github/workflows/preview.yml <<'X'
name: PR preview
on: pull_request_target
permissions: write-all
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - run: bun install && bun run build
      - run: ./scripts/upload-preview.sh
        env:
          PREVIEW_TOKEN: ${{ secrets.PREVIEW_TOKEN }}
X
cat > .github/workflows/triage.yml <<'X'
name: Triage
on:
  issues:
    types: [opened]
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - run: echo "New issue ${{ github.event.issue.title }}" >> triage.log
      - uses: some-org/auto-label@main
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
X
cat > .github/workflows/deploy.yml <<'X'
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/deploy.sh production
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
X
commit "ci: workflows"
cd ..

# ---------- shop: release (feat! breaking, non-conventional hotfix, NOT NULL migration) ----------
mkdir shop && cd shop && g init -q
mkdir -p src db/migrations && pkg shop
echo "export const v = 1;" > src/index.ts; commit "feat: initial shop"
git tag v1.4.0
echo "export const bulk = true;" > src/export.ts; commit "feat(api): add bulk export endpoint"
echo "export const emptyCartOk = true;" > src/cart.ts; commit "fix: crash on empty cart"
echo "ALTER TABLE orders ADD COLUMN region text NOT NULL;" > db/migrations/0042_add_region.sql
echo "export const region = 'eu';" > src/region.ts; commit "feat(orders): store order region"
echo "export const v2only = true;" > src/auth.ts; commit "feat!: drop v1 auth endpoints" "BREAKING CHANGE: /v1/login and /v1/token are removed; clients must use /v2/session."
echo "export const hot = 1;" > src/login.ts; commit "Quick hotfix for login"
echo "{}" > tsconfig.json; commit "chore: bump deps"
echo "# Shop" > README.md; commit "docs: readme"
cd ..

# ======================= harder implementation tasks (iteration 3) =======================
# Shared TypeScript compiler, installed from bun's local cache (no network); fixtures symlink to it.
mkdir -p shared/ts && (cd shared/ts && echo '{"name":"ts-shared","private":true}' > package.json && bun add -d typescript@7.0.2 --prefer-offline >/dev/null 2>&1)
TSMOD="$(cd shared/ts && pwd)/node_modules"
tsconfig() { printf '{\n  "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "types": [] },\n  "include": ["src"]\n}\n' > tsconfig.json; }

# ---------- ledger: rename trap (untested callers, only typecheck sees them) + format trap (distant parser) ----------
mkdir ledger && cd ledger && g init -q
mkdir -p src/invoice src/export src/import src/notify tests && pkg ledger '{"typecheck":"tsc -p ."}' && tsconfig
ln -s "$TSMOD" node_modules && printf 'node_modules\n' > .gitignore
cat > src/types.ts <<'X'
export type Currency = "EUR" | "USD" | "GBP";
export interface Line { desc: string; cents: number }
export interface Invoice { id: string; currency: Currency; total: number; lines: Line[]; dueDate: string }
X
cat > src/money.ts <<'X'
import type { Currency } from "./types";
const SYMBOL: Record<Currency, string> = { EUR: "€", USD: "$", GBP: "£" };
export function formatMoney(cents: number, currency: Currency = "EUR"): string {
  return `${SYMBOL[currency]}${(cents / 100).toFixed(2)}`;
}
X
cat > src/invoice/render.ts <<'X'
import type { Invoice } from "../types";
import { formatMoney } from "../money";
export function renderInvoice(inv: Invoice): string {
  const lines = inv.lines.map((l) => `${l.desc}: ${formatMoney(l.cents, inv.currency)}`);
  return [`Invoice ${inv.id}`, ...lines, `Total: ${formatMoney(inv.total, inv.currency)}`].join("\n");
}
X
cat > src/export/csv.ts <<'X'
import type { Invoice } from "../types";
import { formatMoney } from "../money";
export function toCsv(invoices: Invoice[]): string {
  return ["id,currency,amount", ...invoices.map((i) => `${i.id},${i.currency},${formatMoney(i.total, i.currency)}`)].join("\n");
}
X
cat > src/import/reconcile.ts <<'X'
/** Reads the bank-reconciliation CSV (written by the export job) back into cents per invoice id. */
export function parseCsv(csv: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of csv.split("\n").slice(1)) {
    const [id, , amount] = row.split(",");
    const m = /^[€$£](\d+)\.(\d{2})$/.exec(amount);
    if (!m) throw new Error(`bad amount for ${id}: ${amount}`);
    out[id] = Number(m[1]) * 100 + Number(m[2]);
  }
  return out;
}
X
cat > src/notify/reminder.ts <<'X'
import type { Invoice } from "../types";
import { formatMoney } from "../money";
export function reminderText(invoice: Invoice): string {
  const { id, total, currency, dueDate } = invoice;
  return `Invoice ${id} for ${formatMoney(total, currency)} is due on ${dueDate}.`;
}
X
cat > src/stats.ts <<'X'
import type { Invoice } from "./types";
export function outstanding(invoices: Invoice[]): number {
  return invoices.reduce((sum, inv) => sum + inv["total"], 0);
}
X
cat > tests/money.test.ts <<'X'
import { expect, test } from "bun:test";
import { formatMoney } from "../src/money";
test("formats euros by default", () => { expect(formatMoney(1050)).toBe("€10.50"); });
test("formats dollars", () => { expect(formatMoney(5, "USD")).toBe("$0.05"); });
X
cat > tests/render.test.ts <<'X'
import { expect, test } from "bun:test";
import { renderInvoice } from "../src/invoice/render";
test("renders lines and total", () => {
  const text = renderInvoice({ id: "A1", currency: "GBP", total: 300, dueDate: "2026-11-01", lines: [{ desc: "Tea", cents: 300 }] });
  expect(text).toBe("Invoice A1\nTea: £3.00\nTotal: £3.00");
});
X
cat > tests/roundtrip.test.ts <<'X'
import { expect, test } from "bun:test";
import { toCsv } from "../src/export/csv";
import { parseCsv } from "../src/import/reconcile";
test("export then reconcile keeps every amount", () => {
  const invs = [{ id: "A1", currency: "EUR" as const, total: 1050, dueDate: "", lines: [] }, { id: "B2", currency: "USD" as const, total: 7, dueDate: "", lines: [] }];
  expect(parseCsv(toCsv(invs))).toEqual({ A1: 1050, B2: 7 });
});
X
commit "feat: ledger invoices, export and reconciliation"
cd ..

# ---------- search: case-insensitive find with a performance budget in the suite ----------
mkdir search && cd search && g init -q
mkdir -p src tests && pkg search '{"typecheck":"tsc -p ."}' && tsconfig
ln -s "$TSMOD" node_modules && printf 'node_modules\n' > .gitignore
cat > src/catalog.ts <<'X'
export interface Product { id: string; name: string }
export const stats = { scanned: 0 };
export class Catalog {
  private byName = new Map<string, Product[]>();
  private all: Product[] = [];
  constructor(products: Product[] = []) { for (const p of products) this.add(p); }
  add(p: Product): void {
    this.all.push(p);
    this.byName.set(p.name, [...(this.byName.get(p.name) ?? []), p]);
  }
  find(name: string): Product[] { return this.byName.get(name) ?? []; }
  /** Substring search for the admin tool. */
  scan(fragment: string): Product[] { return this.all.filter((p) => { stats.scanned++; return p.name.includes(fragment); }); }
}
X
cat > tests/catalog.test.ts <<'X'
import { expect, test } from "bun:test";
import { Catalog } from "../src/catalog";
test("finds by exact name", () => { expect(new Catalog([{ id: "1", name: "Laptop" }]).find("Laptop").map((p) => p.id)).toEqual(["1"]); });
test("scan finds substrings", () => { expect(new Catalog([{ id: "1", name: "Laptop" }]).scan("apt").length).toBe(1); });
X
cat > tests/budget.test.ts <<'X'
import { expect, test } from "bun:test";
import { Catalog, stats } from "../src/catalog";
// Checkout calls find() on every request; it must not walk the catalog.
test("find never scans the catalog", () => {
  const c = new Catalog(Array.from({ length: 20000 }, (_, i) => ({ id: String(i), name: `Item ${i}` })));
  stats.scanned = 0;
  for (let i = 0; i < 500; i++) c.find(`Item ${i * 7}`);
  expect(stats.scanned).toBe(0);
});
X
commit "feat: product catalog"
cd ..

# ---------- accounts: column rename with migrations on bun:sqlite ----------
mkdir accounts && cd accounts && g init -q
mkdir -p src/migrations src/reports tests && pkg accounts
cat > src/migrations/index.ts <<'X'
import type { Database } from "bun:sqlite";
export interface Migration { name: string; up(db: Database): void; down(db: Database): void }
export const migrations: Migration[] = [
  {
    name: "001_users",
    up: (db) => db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, user_name TEXT NOT NULL, email TEXT NOT NULL)"),
    down: (db) => db.run("DROP TABLE users"),
  },
  {
    name: "002_logins",
    up: (db) => db.run("CREATE TABLE logins (user_id INTEGER NOT NULL REFERENCES users(id), at TEXT NOT NULL)"),
    down: (db) => db.run("DROP TABLE logins"),
  },
];
X
cat > src/db.ts <<'X'
import { Database } from "bun:sqlite";
import { migrations } from "./migrations";
export function open(path = ":memory:", target = migrations.length): Database {
  const db = new Database(path);
  migrate(db, target);
  return db;
}
/** Moves the schema up or down to `target` (number of applied migrations). */
export function migrate(db: Database, target = migrations.length): void {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
  const row = db.query("SELECT v FROM schema_version").get() as { v: number } | null;
  if (!row) db.run("INSERT INTO schema_version VALUES (0)");
  let v = row?.v ?? 0;
  while (v < target) { migrations[v].up(db); v++; db.run("UPDATE schema_version SET v = ?", [v]); }
  while (v > target) { v--; migrations[v].down(db); db.run("UPDATE schema_version SET v = ?", [v]); }
}
X
cat > src/users.ts <<'X'
import type { Database } from "bun:sqlite";
export interface User { id: number; userName: string; email: string }
export function createUser(db: Database, userName: string, email: string): number {
  return (db.query("INSERT INTO users (user_name, email) VALUES (?, ?) RETURNING id").get(userName, email) as { id: number }).id;
}
export function getUser(db: Database, id: number): User | null {
  const r = db.query("SELECT id, user_name, email FROM users WHERE id = ?").get(id) as { id: number; user_name: string; email: string } | null;
  return r ? { id: r.id, userName: r.user_name, email: r.email } : null;
}
X
cat > src/reports/activity.ts <<'X'
import type { Database } from "bun:sqlite";
/** Logins per user, most active first. */
export function activity(db: Database): { name: string; logins: number }[] {
  return db.query(`SELECT u.user_name AS name, COUNT(l.at) AS logins
                   FROM users u LEFT JOIN logins l ON l.user_id = u.id
                   GROUP BY u.id ORDER BY logins DESC, name`).all() as { name: string; logins: number }[];
}
X
cat > tests/users.test.ts <<'X'
import { expect, test } from "bun:test";
import { open } from "../src/db";
import { createUser, getUser } from "../src/users";
test("creates and reads a user", () => {
  const db = open();
  const id = createUser(db, "ana", "ana@example.com");
  expect(getUser(db, id)).toEqual({ id, userName: "ana", email: "ana@example.com" });
});
X
cat > tests/activity.test.ts <<'X'
import { expect, test } from "bun:test";
import { open } from "../src/db";
import { createUser } from "../src/users";
import { activity } from "../src/reports/activity";
test("counts logins per user", () => {
  const db = open();
  const a = createUser(db, "ana", "a@e.x"); createUser(db, "rui", "r@e.x");
  db.run("INSERT INTO logins VALUES (?, '2026-10-01')", [a]);
  expect(activity(db)).toEqual([{ name: "ana", logins: 1 }, { name: "rui", logins: 0 }]);
});
X
cat > tests/migrations.test.ts <<'X'
import { expect, test } from "bun:test";
import { migrate, open } from "../src/db";
import { migrations } from "../src/migrations";
test("migrates down to zero and back up", () => {
  const db = open();
  migrate(db, 0);
  expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'schema_version'").all()).toEqual([]);
  migrate(db, migrations.length);
  expect((db.query("SELECT v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
});
X
commit "feat: accounts with migrations"
cd ..

# ---------- payments: idempotent pay (control: no gate can catch a race) ----------
mkdir payments && cd payments && g init -q
mkdir -p src tests && pkg payments
cat > src/payments.ts <<'X'
export interface Gateway { charge(amountCents: number, reference: string): Promise<{ id: string }> }
export interface Store { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }
export async function pay(gateway: Gateway, store: Store, orderId: string, amountCents: number): Promise<{ chargeId: string }> {
  const charge = await gateway.charge(amountCents, orderId);
  return { chargeId: charge.id };
}
X
cat > tests/payments.test.ts <<'X'
import { expect, test } from "bun:test";
import { pay } from "../src/payments";
test("charges the order amount", async () => {
  const calls: number[] = [];
  const gw = { charge: async (a: number) => { calls.push(a); return { id: "ch_1" }; } };
  const kv = new Map<string, string>();
  const store = { get: async (k: string) => kv.get(k), set: async (k: string, v: string) => { kv.set(k, v); } };
  expect(await pay(gw, store, "o1", 500)).toEqual({ chargeId: "ch_1" });
  expect(calls).toEqual([500]);
});
X
commit "feat: payments"
cd ..

for d in notify cart auth ledger search accounts payments; do (cd "$d" && bun test >/dev/null 2>&1 && echo "$d: tests pass") || { echo "$d: fixture tests FAIL"; exit 1; }; done
(cd ledger && ./node_modules/.bin/tsc -p . && echo "ledger: typecheck passes")
(cd cart && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo "cart: package.json valid")
