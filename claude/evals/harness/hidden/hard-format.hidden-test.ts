import { expect, test } from "bun:test";
import { formatMoney } from "../src/money";
import { renderInvoice } from "../src/invoice/render";
import { toCsv } from "../src/export/csv";
import { parseCsv } from "../src/import/reconcile";
test("ISO code after the amount", () => {
  expect(formatMoney(1050, "EUR")).toBe("10.50 EUR");
  expect(formatMoney(5, "USD")).toBe("0.05 USD");
  expect(formatMoney(300, "GBP")).toBe("3.00 GBP");
  expect(formatMoney(1050)).toBe("10.50 EUR");
});
test("invoice shows the new format", () => {
  expect(renderInvoice({ id: "A1", currency: "GBP", total: 300, dueDate: "", lines: [{ desc: "Tea", cents: 300 }] } as any)).toBe("Invoice A1\nTea: 3.00 GBP\nTotal: 3.00 GBP");
});
test("export → reconcile still round-trips every currency", () => {
  const invs = [["A1", "EUR", 1050], ["B2", "USD", 7], ["C3", "GBP", 123456]].map(([id, currency, total]) => ({ id, currency, total, dueDate: "", lines: [] })) as any;
  expect(parseCsv(toCsv(invs))).toEqual({ A1: 1050, B2: 7, C3: 123456 });
});
