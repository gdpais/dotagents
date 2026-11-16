import { expect, test } from "bun:test";
import { formatCents, parseCents } from "../src/util/money";
test("formats cents as euros", () => { expect(formatCents(1234)).toBe("€12.34"); expect(formatCents(5)).toBe("€0.05"); expect(formatCents(0)).toBe("€0.00"); expect(formatCents(100)).toBe("€1.00"); });
test("parse unchanged", () => { expect(parseCents("12.34")).toBe(1234); });
