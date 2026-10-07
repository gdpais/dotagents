import { expect, test } from "bun:test";
import { receiptEmail } from "../src/notifications/email";
test("typo fixed", () => { expect(receiptEmail("Ana", "€1").body).toContain("you will receive your receipt"); });
test("rest of the copy unchanged", () => { expect(receiptEmail("Ana", "€1")).toEqual({ subject: "Your receipt", body: "Hi Ana, you will receive your receipt for €1 shortly." }); });
