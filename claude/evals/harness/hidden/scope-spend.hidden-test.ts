import { expect, test } from "bun:test";
import { lastOrderDate, lifetimeSpend } from "../src/orders/summary";
const o = (c: number, d = "2026-01-01") => ({ id: String(c), totalCents: c, date: d });
test("sums every order", () => { expect(lifetimeSpend([o(100), o(250), o(5)])).toBe(355); expect(lifetimeSpend([o(7)])).toBe(7); expect(lifetimeSpend([])).toBe(0); });
test("neighbours unchanged", () => { expect(lastOrderDate([])).toBeNull(); expect(lastOrderDate([o(1, "a"), o(2, "b")])).toBe("b"); });
