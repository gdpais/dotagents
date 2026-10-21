// Hidden acceptance test for TODO 2.1 (URL slugs) in the notes fixtures. Copied in only at scoring time.
import { expect, test } from "bun:test";
import { createNote, createStore } from "../src/notes";

const slug = (s: ReturnType<typeof createStore>, title: string) => createNote(s, { title, body: "" }).slug;

test("lower case, accents removed, other runs become one hyphen, no edge hyphens", () => {
  const s = createStore();
  expect(slug(s, "Hello, World!")).toBe("hello-world");
  expect(slug(s, "  Café   Crème brûlée ")).toBe("cafe-creme-brulee");
  expect(slug(s, "--Rock & Roll--")).toBe("rock-roll");
  expect(slug(s, "Release 2.1 notes")).toBe("release-2-1-notes");
});

test("unique within the store with -2, -3 suffixes", () => {
  const s = createStore();
  expect([slug(s, "Hello world"), slug(s, "Hello, World"), slug(s, "hello world!")]).toEqual(["hello-world", "hello-world-2", "hello-world-3"]);
  expect(slug(createStore(), "Hello world")).toBe("hello-world");
});

test("at most 60 characters including the suffix, never ending in a hyphen", () => {
  const s = createStore();
  const long = `${"a".repeat(30)} ${"b".repeat(40)}`;
  const first = slug(s, long)!, second = slug(s, long)!;
  for (const x of [first, second]) {
    expect(x.length).toBeLessThanOrEqual(60);
    expect(x.endsWith("-")).toBe(false);
    expect(x.startsWith("a".repeat(30))).toBe(true);
  }
  expect(second.endsWith("-2")).toBe(true);
  expect(second).not.toBe(first);
  const edge = slug(createStore(), `${"c".repeat(59)} d`)!;
  expect(edge.length).toBeLessThanOrEqual(60);
  expect(edge.endsWith("-")).toBe(false);
});

test("title validation from 1.2 still holds", () => {
  expect(() => createNote(createStore(), { title: "   ", body: "" })).toThrow(RangeError);
});
