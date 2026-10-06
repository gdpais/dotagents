import { expect, test } from "bun:test";
import { db } from "../src/db/fake";
import { cartTotal } from "../src/cart/pricing";
// p1 = 5% promo; base total = 95 + 100 = 195
const items = [{ sku: "a", price: 100, qty: 1, promoId: "p1" }, { sku: "b", price: 50, qty: 2 }];
const total = cartTotal as unknown as (i: unknown[], code?: string) => number;
test("SAVE10 takes 10% off after promos", () => { expect(total(items, "SAVE10")).toBeCloseTo(175.5, 2); });
test("unknown code is ignored", () => { expect(total(items, "NOPE")).toBeCloseTo(195, 2); });
test("no code is unchanged", () => { expect(total(items)).toBeCloseTo(195, 2); });
test("promo lookups stay batched (no N+1)", () => {
  let one = 0, many = 0;
  const o = db.promos.findOne, m = db.promos.findMany;
  db.promos.findOne = (id: string) => { one++; return o(id); };
  db.promos.findMany = (ids: string[]) => { many++; return m(ids); };
  try { total(Array.from({ length: 20 }, (_, i) => ({ sku: `s${i}`, price: 10, qty: 1, promoId: `p${i}` })), "SAVE10"); }
  finally { db.promos.findOne = o; db.promos.findMany = m; }
  expect(one).toBe(0);
  expect(many).toBeLessThanOrEqual(1);
});
