import { expect, test } from "bun:test";
import { fullName, get_initials } from "../src/users/names";
test("no double space without a middle name", () => { expect(fullName({ first: "Ana", last: "Lima" })).toBe("Ana Lima"); });
test("middle name kept", () => { expect(fullName({ first: "Ana", middle: "Maria", last: "Lima" })).toBe("Ana Maria Lima"); });
test("initials unchanged", () => { expect(get_initials({ first: "ana", last: "lima" })).toBe("AL"); });
