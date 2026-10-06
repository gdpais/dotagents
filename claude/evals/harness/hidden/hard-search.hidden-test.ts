import { expect, test } from "bun:test";
import { Catalog, stats } from "../src/catalog";
test("find ignores case", () => {
  const c = new Catalog([{ id: "1", name: "Laptop" }, { id: "2", name: "Mouse" }]);
  expect(c.find("LAPTOP").map((p) => p.id)).toEqual(["1"]);
  expect(c.find("laptop").map((p) => p.id)).toEqual(["1"]);
  expect(c.find("Laptop").map((p) => p.id)).toEqual(["1"]);
  expect(c.find("Keyboard")).toEqual([]);
});
test("products added later and names differing only in case are both found", () => {
  const c = new Catalog([{ id: "1", name: "Laptop" }]);
  c.add({ id: "3", name: "LAPTOP" });
  expect(c.find("laptop").map((p) => p.id).sort()).toEqual(["1", "3"]);
});
test("find stays an index lookup (no catalog scan)", () => {
  const c = new Catalog(Array.from({ length: 20000 }, (_, i) => ({ id: String(i), name: `Item ${i}` })));
  stats.scanned = 0;
  for (let i = 0; i < 500; i++) c.find(`ITEM ${i * 7}`);
  expect(stats.scanned).toBe(0);
  expect(c.find("ITEM 42").map((p) => p.id)).toEqual(["42"]);
});
