import { expect, test } from "bun:test";
import { pay } from "../src/payments";
function setup() {
  const charges: string[] = [];
  let n = 0;
  const gateway = { charge: async (_a: number, ref: string) => { await Bun.sleep(15); charges.push(ref); return { id: `ch_${++n}` }; } };
  const kv = new Map<string, string>();
  const store = { get: async (k: string) => { await Bun.sleep(1); return kv.get(k); }, set: async (k: string, v: string) => { await Bun.sleep(1); kv.set(k, v); } };
  return { charges, gateway, store };
}
test("a second call for the same order does not charge again", async () => {
  const { charges, gateway, store } = setup();
  const a = await pay(gateway, store, "o1", 500);
  const b = await pay(gateway, store, "o1", 500);
  expect(charges).toEqual(["o1"]);
  expect(b.chargeId).toBe(a.chargeId);
});
test("different orders are charged separately", async () => {
  const { charges, gateway, store } = setup();
  await pay(gateway, store, "o1", 500);
  await pay(gateway, store, "o2", 700);
  expect(charges.sort()).toEqual(["o1", "o2"]);
});
test("a double-click (concurrent calls) charges once", async () => {
  const { charges, gateway, store } = setup();
  const results = await Promise.all([pay(gateway, store, "o9", 500), pay(gateway, store, "o9", 500), pay(gateway, store, "o9", 500)]);
  expect(charges).toEqual(["o9"]);
  expect(new Set(results.map((r) => r.chargeId)).size).toBe(1);
});
