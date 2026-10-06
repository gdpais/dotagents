#!/usr/bin/env bun
/**
 * Collect wall-clock benchmark samples and compare two sample sets on the
 * percentiles that matter (p90 and p95 by default), each with a bootstrap
 * confidence interval of the change, so noise is not reported as a regression.
 *
 * Subcommands:
 *   run --cmd "COMMAND" [--runs 40] [--warmup 3] [--out FILE] [--cwd DIR]
 *       Run COMMAND through `sh -c` warmup+runs times; record each run's wall time
 *       in milliseconds. Fails (exit 1) if any run exits non-zero. Prints or writes
 *       {command, runs, warmup, samples_ms, summary, env}.
 *   stats FILE
 *       Summary statistics of one sample file (p50, p90, p95, p99, mean, spread).
 *   compare BASE HEAD [--stats p90,p95] [--threshold 5] [--budget p95=300,p90=250] [--seed 1]
 *       Compare HEAD against BASE on each statistic in --stats (p50, p90, p95, p99).
 *       Per statistic: change in % of BASE, and a 95% bootstrap confidence interval.
 *         regression        CI entirely above +threshold%
 *         improvement       CI entirely below -threshold%
 *         within threshold  CI excludes 0 but does not clear the threshold
 *         no significant change   CI includes 0
 *       The overall verdict is the worst one across the gated statistics
 *       (regression > within threshold > no significant change > improvement);
 *       `inconclusive` when either side has fewer than 5 samples.
 *       --budget checks HEAD's percentiles against absolute limits in ms.
 *       Exit 1 on regression or budget breach, else 0.
 *
 * Tail percentiles need samples: p90 is fragile under 20 runs, p95 under 40,
 * p99 under 200; the output warns when that is the case.
 *
 * Sample files: a JSON array of numbers, a JSON object with `samples_ms`, or text
 * with one number per line (CSV first column). Units are milliseconds.
 */
import { cpus } from "node:os";
import { parseArgs } from "node:util";

export const STATS = { p50: 0.5, p90: 0.9, p95: 0.95, p99: 0.99 } as const;
export type Stat = keyof typeof STATS;
const MIN_SAMPLES: Record<Stat, number> = { p50: 10, p90: 20, p95: 40, p99: 200 };

export interface Summary { n: number; mean: number; p50: number; p90: number; p95: number; p99: number; min: number; max: number; stdev: number; cv_pct: number }

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** Linear-interpolated quantile (same definition as numpy's default). */
export function quantile(xs: number[], q: number): number {
  const s = sorted(xs);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}

export function summarize(xs: number[]): Summary {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const stdev = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n, mean: round(mean), p50: round(quantile(xs, 0.5)), p90: round(quantile(xs, 0.9)), p95: round(quantile(xs, 0.95)), p99: round(quantile(xs, 0.99)),
    min: round(Math.min(...xs)), max: round(Math.max(...xs)), stdev: round(stdev), cv_pct: round(mean ? (stdev / mean) * 100 : 0, 1),
  };
}

/** Deterministic PRNG (mulberry32) so the bootstrap is reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% bootstrap CI of (quantile_q(head)/quantile_q(base) - 1) * 100. */
export function bootstrapDeltaCI(base: number[], head: number[], q = 0.5, iterations = 2000, seed = 1): [number, number] {
  const r = rng(seed);
  const resample = (xs: number[]) => Array.from({ length: xs.length }, () => xs[Math.floor(r() * xs.length)]);
  const deltas: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const b = quantile(resample(base), q);
    if (b > 0) deltas.push((quantile(resample(head), q) / b - 1) * 100);
  }
  return [round(quantile(deltas, 0.025), 2), round(quantile(deltas, 0.975), 2)];
}

/** Two-sided Mann-Whitney U test (normal approximation, tie-corrected): has the whole distribution shifted? */
export function mannWhitney(a: number[], b: number[]): { u: number; p: number } {
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    const t = j - i + 1;
    tieTerm += t ** 3 - t;
    i = j + 1;
  }
  const n1 = a.length, n2 = b.length, n = n1 + n2;
  const r1 = all.reduce((s, x, i) => s + (x.g === 0 ? ranks[i] : 0), 0);
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return { u, p: 1 };
  const z = (Math.abs(u1 - (n1 * n2) / 2) - 0.5) / sigma;
  return { u, p: round(Math.min(1, 2 * (1 - normalCdf(Math.max(z, 0)))), 4) };
}

function normalCdf(z: number): number {
  // Abramowitz-Stegun 7.1.26 approximation of erf.
  const t = 1 / (1 + 0.3275911 * (z / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + y);
}

const RANK = { regression: 3, "within threshold": 2, "no significant change": 1, improvement: 0 } as const;
type Verdict = keyof typeof RANK;

export function verdictFor(ci: [number, number], threshold: number): Verdict {
  if (ci[0] > threshold) return "regression";
  if (ci[1] < -threshold) return "improvement";
  if (ci[0] > 0 || ci[1] < 0) return "within threshold";
  return "no significant change";
}

export interface CompareOptions { stats?: Stat[]; threshold?: number; seed?: number; budget?: Partial<Record<Stat, number>> }

export function compare(base: number[], head: number[], opts: CompareOptions = {}) {
  const stats = opts.stats ?? ["p90", "p95"];
  const threshold = opts.threshold ?? 5;
  const seed = opts.seed ?? 1;
  const b = summarize(base), h = summarize(head);
  const warnings: string[] = [];
  for (const s of stats) {
    const need = MIN_SAMPLES[s];
    if (b.n < need || h.n < need) warnings.push(`${s} from ${Math.min(b.n, h.n)} samples is fragile; collect at least ${need} runs per side`);
  }
  if (b.cv_pct > 10 || h.cv_pct > 10) warnings.push("coefficient of variation above 10%; the environment is noisy (pin CPU, close other work, add warmup)");
  const budget = opts.budget && Object.keys(opts.budget).length
    ? Object.fromEntries(Object.entries(opts.budget).map(([s, limit]) => [s, { limit_ms: limit, head_ms: h[s as Stat], breached: h[s as Stat] > (limit as number) }]))
    : undefined;
  const budgetBreached = budget ? Object.values(budget).some((x) => x.breached) : false;
  if (b.n < 5 || h.n < 5) return { base: b, head: h, gated_on: stats, threshold_pct: threshold, verdict: "inconclusive", budget, budget_breached: budgetBreached, warnings };

  const per = Object.fromEntries(stats.map((s, i) => {
    const q = STATS[s];
    const ci = bootstrapDeltaCI(base, head, q, 2000, seed + i);
    return [s, { base_ms: b[s], head_ms: h[s], delta_pct: round((h[s] / b[s] - 1) * 100, 2), ci95_delta_pct: ci, verdict: verdictFor(ci, threshold) }];
  }));
  const verdict = Object.values(per).map((x) => x.verdict as Verdict).reduce((w, v) => (RANK[v] > RANK[w] ? v : w), "improvement" as Verdict);
  // `improvement` only when every gated statistic improved
  const overall = verdict === "improvement" && !Object.values(per).every((x) => x.verdict === "improvement") ? "no significant change" : verdict;
  return {
    base: b, head: h, gated_on: stats, threshold_pct: threshold, per_stat: per, verdict: overall,
    distribution_shift: mannWhitney(base, head), budget, budget_breached: budgetBreached, warnings,
  };
}

export function parseSamples(text: string): number[] {
  const t = text.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    const j = JSON.parse(t);
    const xs = Array.isArray(j) ? j : j.samples_ms;
    if (!Array.isArray(xs)) throw new Error("JSON must be an array or have samples_ms");
    return xs.map(Number).filter(Number.isFinite);
  }
  return t.split(/\r?\n/).map((l) => parseFloat(l.split(",")[0])).filter(Number.isFinite);
}

export function parseStats(text: string): Stat[] {
  const out = text.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = out.filter((s) => !(s in STATS));
  if (bad.length || !out.length) throw new Error(`--stats takes a comma list of ${Object.keys(STATS).join(", ")}`);
  return out as Stat[];
}

export function parseBudget(text: string): Partial<Record<Stat, number>> {
  const out: Partial<Record<Stat, number>> = {};
  for (const part of text.split(",").filter(Boolean)) {
    const [s, v] = part.split("=").map((x) => x.trim().toLowerCase());
    if (!(s in STATS) || !Number.isFinite(Number(v))) throw new Error(`--budget takes stat=ms pairs, e.g. p95=300,p90=250 (got "${part}")`);
    out[s as Stat] = Number(v);
  }
  return out;
}

async function runBench(cmd: string, runs: number, warmup: number, cwd?: string) {
  const samples: number[] = [];
  for (let i = 0; i < warmup + runs; i++) {
    const start = performance.now();
    const p = Bun.spawnSync(["sh", "-c", cmd], { cwd, stdout: "ignore", stderr: "pipe" });
    const ms = performance.now() - start;
    if (p.exitCode !== 0) throw new Error(`run ${i + 1} exited ${p.exitCode}: ${p.stderr.toString().trim().slice(-500)}`);
    if (i >= warmup) samples.push(round(ms));
  }
  return {
    command: cmd, runs, warmup, samples_ms: samples, summary: summarize(samples),
    env: { platform: process.platform, arch: process.arch, cpus: cpus().length, cpu_model: cpus()[0]?.model ?? "unknown", bun: Bun.version, recorded_at: new Date().toISOString() },
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [sub, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: {
      cmd: { type: "string" }, runs: { type: "string" }, warmup: { type: "string" }, out: { type: "string" }, cwd: { type: "string" },
      stats: { type: "string" }, threshold: { type: "string" }, seed: { type: "string" }, budget: { type: "string" } } });
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const { values: o, positionals } = parsed;
  const load = async (f: string) => parseSamples(await Bun.file(f).text());
  try {
    if (sub === "run") {
      if (!o.cmd) throw new Error("run needs --cmd");
      const result = await runBench(o.cmd, Number(o.runs ?? 40), Number(o.warmup ?? 3), o.cwd);
      const text = JSON.stringify(result, null, 2);
      if (o.out) { await Bun.write(o.out, text + "\n"); console.log(JSON.stringify({ wrote: o.out, summary: result.summary })); }
      else console.log(text);
      return 0;
    }
    if (sub === "stats" && positionals.length === 1) { console.log(JSON.stringify(summarize(await load(positionals[0])), null, 2)); return 0; }
    if (sub === "compare" && positionals.length === 2) {
      const r = compare(await load(positionals[0]), await load(positionals[1]), {
        stats: o.stats ? parseStats(o.stats) : undefined, threshold: o.threshold === undefined ? undefined : Number(o.threshold),
        seed: o.seed === undefined ? undefined : Number(o.seed), budget: o.budget ? parseBudget(o.budget) : undefined,
      });
      console.log(JSON.stringify(r, null, 2));
      return r.verdict === "regression" || r.budget_breached ? 1 : 0;
    }
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message }));
    return sub === "run" ? 1 : 2;
  }
  console.error("usage: bench_stats.ts run --cmd CMD [--runs N] [--warmup N] [--out FILE] | stats FILE | compare BASE HEAD [--stats p90,p95] [--threshold PCT] [--budget p95=MS,...]");
  return 2;
}

if (import.meta.main) process.exit(await main());
