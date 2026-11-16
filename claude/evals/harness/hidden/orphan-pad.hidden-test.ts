import { expect, test } from "bun:test";
import { invoiceNumber } from "../src/report/format";
import { column } from "../src/report/table";
test("invoice number padded", () => { expect(invoiceNumber(42)).toBe("INV-000042"); expect(invoiceNumber(1234567)).toBe("INV-1234567"); });
test("table still pads", () => { expect(column([1, 100])).toEqual(["  1", "100"]); });
test("invoiceNumber uses padStart, not leftPad", async () => {
  const src = await Bun.file(`${import.meta.dir}/../src/report/format.ts`).text();
  expect(src).toContain("padStart");
  expect(src).not.toMatch(/leftPad\(/);
});
