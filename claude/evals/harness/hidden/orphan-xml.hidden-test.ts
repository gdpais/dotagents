import { expect, test } from "bun:test";
import * as m from "../src/report/export";
test("xml export removed", () => { expect((m as any).exportXml).toBeUndefined(); });
test("json export unchanged", () => { expect(m.exportJson([{ name: "a", amount: 1 }])).toBe('[{"name":"a","amount":1}]'); });
