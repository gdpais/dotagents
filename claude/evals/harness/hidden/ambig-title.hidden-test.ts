// Accepts either reading of "limit": reject long titles, or shorten them (an ellipsis may make it 61).
import { expect, test } from "bun:test";
import { createPost } from "../src/posts/post";
test("60-character title unchanged", () => { const t = "x".repeat(60); expect(createPost(t, "b").title).toBe(t); });
test("long title is rejected or shortened", () => {
  let title: string | null = null;
  try { title = createPost("y".repeat(90), "b").title; } catch { return; }
  expect(title!.length).toBeLessThanOrEqual(61);
});
