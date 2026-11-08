/**
 * The stop gate reuses quality results for files it already checked (preflight's `cache`, keyed by `treeKey`).
 * Each quality command appends a line to a counter file outside the repo, so a test sees how often it really ran.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { preflight, render, treeKey, type QualityCache, type QualityResult } from "../skills/delivery-lifecycle/scripts/preflight";

const STOP = join(import.meta.dir, "..", "hooks", "stop_gate.ts");
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

let dir: string, counter: string;
const sh = (...a: string[]) => { const p = Bun.spawnSync(["git", ...a], { cwd: dir, env: ENV }); if (p.exitCode) throw new Error(p.stderr.toString()); };
const put = (f: string, t: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); };
const runs = () => { try { return readFileSync(counter, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
const mapCache = (): QualityCache & { map: Map<string, QualityResult> } => {
  const map = new Map<string, QualityResult>();
  return { map, get: (k) => map.get(k), set: (k, r) => void map.set(k, r) };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "delivery-cache-"));
  counter = join(mkdtempSync(join(tmpdir(), "delivery-count-")), "runs");
  sh("init", "-q", "-b", "main");
  put("package.json", JSON.stringify({ name: "x", scripts: { test: `echo run >> ${counter}` } }));
  put("src/a.ts", "export const a = 1;\n");
  sh("add", "."); sh("commit", "-qm", "init");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(dirname(counter), { recursive: true, force: true }); });

test("treeKey follows the files, not HEAD: committing checked files keeps it, any edit changes it", async () => {
  const clean = await treeKey(dir);
  expect(clean).toMatch(/^[0-9a-z]+$/);
  put("src/a.ts", "export const a = 2;\n");
  const edited = await treeKey(dir);
  expect(edited).not.toBe(clean);
  put("src/b.ts", "export const b = 1;\n"); // untracked
  const withNew = await treeKey(dir);
  expect(withNew).not.toBe(edited);
  sh("add", "src/a.ts"); // staged: the same files
  expect(await treeKey(dir)).toBe(withNew);
  sh("add", "."); sh("commit", "-qm", "work");
  expect(await treeKey(dir)).toBe(withNew);
  unlinkSync(join(dir, "src/b.ts"));
  expect(await treeKey(dir)).toBe(edited);
  put(".gitignore", "out/\n"); sh("add", "."); sh("commit", "-qm", "ignore");
  const ignoredBase = await treeKey(dir);
  put("out/build.js", "x\n"); // ignored output doesn't count
  expect(await treeKey(dir)).toBe(ignoredBase);
});

test("preflight with a cache: the same files reuse the result, an edit runs the command again", async () => {
  const cache = mapCache();
  const check = { base: "main", run: ["test" as const], cache };
  sh("checkout", "-qb", "feature/x");
  put("src/a.ts", "export const a = 2;\n");
  const first = await preflight(dir, check);
  if (typeof first === "string") throw new Error(first);
  expect(first.quality.map((q) => [q.kind, q.passed, q.cached])).toEqual([["test", true, undefined]]);
  expect(runs()).toBe(1);

  const second = await preflight(dir, check);
  if (typeof second === "string") throw new Error(second);
  expect(second.quality[0]).toMatchObject({ kind: "test", passed: true, cached: true });
  expect(render(second)).toContain("(cached: same files as an earlier check)");
  expect(runs()).toBe(1);

  sh("add", "."); sh("commit", "-qm", "work"); // the checked files, now committed: still the same files
  await preflight(dir, check);
  expect(runs()).toBe(1);
  put("README.md", "notes\n"); // any file the commands could read counts
  await preflight(dir, check);
  expect(runs()).toBe(2);
  put("src/a.ts", "export const a = 3;\n");
  await preflight(dir, check);
  expect(runs()).toBe(3);
  expect(cache.map.size).toBe(3); // a Map keeps every key; the stop gate's cache keeps only the latest files'
});

test("preflight: a failing result is reused and says so; a timed-out one is never stored", async () => {
  const cache = mapCache();
  put("package.json", JSON.stringify({ name: "x", scripts: { test: `echo run >> ${counter}; exit 1` } }));
  const a = await preflight(dir, { run: ["test"], cache });
  const b = await preflight(dir, { run: ["test"], cache });
  if (typeof a === "string" || typeof b === "string") throw new Error("preflight failed");
  expect(runs()).toBe(1);
  expect(b.blocking.join("\n")).toContain("test failed: `npm test` exit 1 (result from an earlier check of the same files)");

  put("package.json", JSON.stringify({ name: "x", scripts: { test: `echo run >> ${counter}; sleep 5` } }));
  for (let i = 0; i < 2; i++) {
    const t = await preflight(dir, { run: ["test"], timeoutS: 1, cache });
    if (typeof t === "string") throw new Error(t);
    expect(t.quality[0]).toMatchObject({ timed_out: true });
    expect(t.quality[0].cached).toBeUndefined();
  }
  expect(runs()).toBe(3);
}, 20_000);

test("stop gate: a second stop on the same files doesn't run the quality commands again", () => {
  put("src/a.ts", "export const a = 2;\n");
  const transcript = join(dir, ".claude", "t.jsonl");
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: join(dir, "src/a.ts") } }] } }));
  const session = `cache-${process.pid}-${Date.now()}`;
  const stop = () => Bun.spawnSync([process.execPath, STOP], { stdin: Buffer.from(JSON.stringify({ session_id: session, transcript_path: transcript, cwd: dir })), env: ENV });
  try {
    expect(stop().exitCode).toBe(0);
    expect(stop().exitCode).toBe(0);
    expect(runs()).toBe(1);
    put("src/a.ts", "export const a = 3;\n");
    expect(stop().exitCode).toBe(0);
    expect(runs()).toBe(2);
    const state = JSON.parse(readFileSync(join(tmpdir(), "delivery-stop-gate", `${session}.json`), "utf8"));
    expect(Object.keys(state.quality)).toHaveLength(1); // only the latest files' results are kept
  } finally {
    rmSync(join(tmpdir(), "delivery-stop-gate", `${session}.json`), { force: true });
  }
});
