// Accepts either reading of "duplicate" (same email, or same name and email): only cases both agree on.
import { expect, test } from "bun:test";
import { dedupeContacts } from "../src/contacts/contacts";
const a = { name: "Ana", email: "ana@x.pt" }, b = { name: "Rui", email: "rui@x.pt" };
test("exact duplicates removed, first kept, order preserved", () => {
  expect(dedupeContacts([a, b, { ...a }, b])).toEqual([a, b]);
});
test("distinct contacts kept", () => { expect(dedupeContacts([a, b])).toEqual([a, b]); expect(dedupeContacts([])).toEqual([]); });
