import { expect, test } from "bun:test";
import { averageItemPrice } from "../src/cart/stats";
test("empty cart averages to 0", () => { expect(averageItemPrice([])).toBe(0); });
test("weighted average unchanged", () => { expect(averageItemPrice([{ sku: "a", price: 10, qty: 3 }, { sku: "b", price: 30, qty: 1 }] as any)).toBe(15); });
