import { expect, test } from "bun:test";
import { pageCount, pageSlice } from "../src/api/paginate";
test("rounds partial pages up", () => { expect(pageCount(21, 10)).toBe(3); expect(pageCount(20, 10)).toBe(2); expect(pageCount(1, 10)).toBe(1); expect(pageCount(0, 10)).toBe(0); });
test("slice unchanged", () => { expect(pageSlice([1, 2, 3, 4, 5], 2, 2)).toEqual([5]); expect(pageSlice([1, 2], 0, 5)).toEqual([1, 2]); });
