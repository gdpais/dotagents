import { expect, test } from "bun:test";
import { reminderText } from "../src/notify/reminder";
import { outstanding } from "../src/stats";
import { renderInvoice } from "../src/invoice/render";
import { toCsv } from "../src/export/csv";
import { parseCsv } from "../src/import/reconcile";
const inv = { id: "A1", currency: "EUR", totalCents: 1050, dueDate: "2026-11-01", lines: [{ desc: "Tea", cents: 1050 }] } as any;
test("reminder uses totalCents", () => { expect(reminderText(inv)).toBe("Invoice A1 for €10.50 is due on 2026-11-01."); });
test("outstanding sums totalCents", () => { expect(outstanding([inv, { ...inv, id: "B2", totalCents: 50 }])).toBe(1100); });
test("render and export use totalCents", () => {
  expect(renderInvoice(inv)).toContain("Total: €10.50");
  expect(parseCsv(toCsv([inv]))).toEqual({ A1: 1050 });
});
