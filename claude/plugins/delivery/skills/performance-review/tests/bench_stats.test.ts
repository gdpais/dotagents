/**
 * Tests for scripts/bench_stats.ts. Run with `bun test` from the skill folder.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapDeltaCI, compare, mannWhitney, parseBudget, parseSamples, parseStats, quantile, rng, summarize, verdictFor } from "../scripts/bench_stats";

const SCRIPT = join(import.meta.dir, "..", "scripts", "bench_stats.ts");

/** Samples around `center` with ±spread noise, deterministic. */
const noisy = (center: number, spread: number, n = 60, seed = 7) => {
  const r = rng(seed);
  return Array.from({ length: n }, () => center + (r() * 2 - 1) * spread);
};
/** Same body as `noisy` but with a slow tail: `share` of runs take `tail` ms extra. */
const withTail = (center: number, tail: number, share: number, n = 60, seed = 11) => {
  const r = rng(seed);
  return noisy(center, 2, n, seed).map((x) => (r() < share ? x + tail : x));
};

test("quantile interpolates; summarize reports p50/p90/p95/p99", () => {
  expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  const xs = Array.from({ length: 101 }, (_, i) => i);
  const s = summarize(xs);
  expect([s.p50, s.p90, s.p95, s.p99]).toEqual([50, 90, 95, 99]);
});

test("verdictFor maps a confidence interval to a verdict", () => {
  expect(verdictFor([6, 9], 5)).toBe("regression");
  expect(verdictFor([-9, -6], 5)).toBe("improvement");
  expect(verdictFor([1, 4], 5)).toBe("within threshold");
  expect(verdictFor([-2, 3], 5)).toBe("no significant change");
});

test("default gates on p90 and p95; clear regression", () => {
  const r = compare(noisy(100, 2), noisy(120, 2, 60, 9));
  expect(r.gated_on).toEqual(["p90", "p95"]);
  expect(r.verdict).toBe("regression");
  expect(r.per_stat!.p95.ci95_delta_pct[0]).toBeGreaterThan(5);
});

test("a tail-only regression is caught on p95 while the median does not move", () => {
  const base = withTail(100, 0, 0), head = withTail(100, 80, 0.15);
  const tail = compare(base, head);
  expect(tail.verdict).toBe("regression");
  expect(tail.per_stat!.p95.verdict).toBe("regression");
  expect(compare(base, head, { stats: ["p50"] }).verdict).not.toBe("regression");
});

test("clear improvement needs every gated statistic to improve", () => {
  expect(compare(noisy(100, 2), noisy(70, 2, 60, 9)).verdict).toBe("improvement");
});

test("same distribution is no significant change", () => {
  expect(compare(noisy(100, 5, 60, 1), noisy(100, 5, 60, 2)).verdict).toBe("no significant change");
});

test("small but real change is within threshold", () => {
  expect(compare(noisy(100, 0.5, 60, 1), noisy(102, 0.5, 60, 2)).verdict).toBe("within threshold");
});

test("few samples warn per percentile; under 5 is inconclusive", () => {
  expect(compare([1, 2, 3], [4, 5, 6]).verdict).toBe("inconclusive");
  const r = compare(noisy(100, 2, 25), noisy(100, 2, 25, 3));
  expect(r.warnings.join(" ")).toContain("p95 from 25 samples is fragile");
  expect(r.warnings.join(" ")).not.toContain("p90 from");
});

test("budget per percentile is checked on head", () => {
  const r = compare(noisy(100, 2), noisy(100, 2, 60, 8), { budget: { p95: 90, p90: 200 } });
  expect(r.budget!.p95.breached).toBe(true);
  expect(r.budget!.p90.breached).toBe(false);
  expect(r.budget_breached).toBe(true);
});

test("bootstrap is deterministic for a seed", () => {
  const a = noisy(100, 5), b = noisy(110, 5, 60, 4);
  expect(bootstrapDeltaCI(a, b, 0.95, 500, 42)).toEqual(bootstrapDeltaCI(a, b, 0.95, 500, 42));
});

test("Mann-Whitney on identical samples gives p = 1", () => {
  expect(mannWhitney([5, 5, 5], [5, 5, 5]).p).toBe(1);
});

test("parsers: samples, stats and budget", () => {
  expect(parseSamples("[1, 2.5]")).toEqual([1, 2.5]);
  expect(parseSamples('{"samples_ms": [3]}')).toEqual([3]);
  expect(parseSamples("4\n5,ignored\n\nx\n")).toEqual([4, 5]);
  expect(parseStats("P95, p90")).toEqual(["p95", "p90"]);
  expect(() => parseStats("p42")).toThrow();
  expect(parseBudget("p95=300,p90=250")).toEqual({ p95: 300, p90: 250 });
  expect(() => parseBudget("p95")).toThrow();
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bench-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("CLI run records samples and compare exits 1 on regression", () => {
  const out = join(dir, "base.json");
  const p = Bun.spawnSync([process.execPath, SCRIPT, "run", "--cmd", "true", "--runs", "5", "--warmup", "1", "--out", out]);
  expect(p.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(out, "utf8")).samples_ms).toHaveLength(5);

  writeFileSync(join(dir, "a.json"), JSON.stringify(noisy(100, 2)));
  writeFileSync(join(dir, "b.json"), JSON.stringify(noisy(130, 2, 60, 5)));
  const c = Bun.spawnSync([process.execPath, SCRIPT, "compare", join(dir, "a.json"), join(dir, "b.json"), "--stats", "p90,p95"]);
  expect(c.exitCode).toBe(1);
  expect(JSON.parse(c.stdout.toString()).verdict).toBe("regression");
});

test("CLI budget breach exits 1 even without a regression", () => {
  writeFileSync(join(dir, "a.json"), JSON.stringify(noisy(100, 2)));
  writeFileSync(join(dir, "b.json"), JSON.stringify(noisy(100, 2, 60, 5)));
  const c = Bun.spawnSync([process.execPath, SCRIPT, "compare", join(dir, "a.json"), join(dir, "b.json"), "--budget", "p95=95"]);
  expect(c.exitCode).toBe(1);
  expect(JSON.parse(c.stdout.toString()).budget_breached).toBe(true);
});

test("CLI run fails when the command fails", () => {
  const p = Bun.spawnSync([process.execPath, SCRIPT, "run", "--cmd", "exit 4", "--runs", "2"]);
  expect(p.exitCode).toBe(1);
  expect(JSON.parse(p.stdout.toString()).error).toContain("exited 4");
});
