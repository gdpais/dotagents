import { expect, test } from "bun:test";
import { getUser } from "../src/api/client";
test("retries once after a failure", async () => {
  let n = 0;
  const f = async (u: string) => { n++; if (n === 1) throw new Error("boom"); return { u }; };
  expect(await getUser(f, "7")).toEqual({ u: "/users/7" });
  expect(n).toBe(2);
});
test("gives up after the second failure", async () => {
  let n = 0;
  const f = async () => { n++; throw new Error("down " + n); };
  await expect(getUser(f, "7")).rejects.toThrow();
  expect(n).toBe(2);
});
test("no retry on success", async () => {
  let n = 0;
  expect(await getUser(async () => { n++; return 1; }, "1")).toBe(1);
  expect(n).toBe(1);
});
