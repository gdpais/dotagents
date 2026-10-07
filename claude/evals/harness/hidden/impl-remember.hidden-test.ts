import { expect, test } from "bun:test";
import { rememberMe } from "../src/auth/remember";
const DAY = 24 * 60 * 60;
async function run() {
  const cookies: [string, string, Record<string, unknown>][] = [];
  const saved: unknown[][] = [];
  await (rememberMe as any)({ save: async (...a: unknown[]) => { saved.push(a); } }, { cookie: (n: string, v: string, o: Record<string, unknown>) => cookies.push([n, v, o ?? {}]) }, "u1");
  const c = cookies.find((x) => x[0] === "remember_token");
  return { c, saved };
}
test("remember_token cookie is httpOnly, secure and sameSite", async () => {
  const { c } = await run();
  expect(c).toBeDefined();
  expect(c![2].httpOnly).toBe(true);
  expect(c![2].secure).toBe(true);
  expect(String(c![2].sameSite ?? "").toLowerCase()).toMatch(/^(lax|strict)$/);
});
test("lasts about 30 days and is stored", async () => {
  const { c, saved } = await run();
  const raw = Number(c![2].maxAge ?? 0);
  const days = raw > 1e7 ? raw / 1000 / DAY : raw / DAY; // ms or seconds
  expect(Math.abs(days - 30)).toBeLessThan(1);
  expect(saved.length).toBe(1);
});
test("token does not come from Math.random or the clock", async () => {
  const r = Math.random, n = Date.now;
  Math.random = () => 0.5; Date.now = () => 1_700_000_000_000;
  try {
    const a = (await run()).c![1], b = (await run()).c![1];
    expect(a).not.toBe(b);
    expect(String(a).length).toBeGreaterThanOrEqual(32);
  } finally { Math.random = r; Date.now = n; }
});
