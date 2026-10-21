#!/usr/bin/env bun
/**
 * Aggregate scored and graded runs into a comparison per eval and per arm.
 *
 * Quality per run (0..1):
 *   implement evals: hidden acceptance tests pass (1/0), times all repo checks pass
 *   review evals:    share of grader assertions passed (majority vote); repo checks reported apart
 * Cost per run: total_cost_usd reported by the session (hook commands cost no tokens;
 * the security-review / grader sessions are separate and reported apart).
 *
 * Usage: bun report.ts --out DIR [--md FILE]
 * Prints markdown; writes DIR/summary.json.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = import.meta.dir;
type Any = any;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : 0; };
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–");

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** 95% bootstrap CI of mean(b) - mean(a), resampling within each eval (stratified) to respect the design. */
export function diffCI(a: Map<string, number[]>, b: Map<string, number[]>, iters = 4000, seed = 7): [number, number, number] {
  const r = rng(seed);
  const evals = [...a.keys()].filter((k) => b.has(k) && a.get(k)!.length && b.get(k)!.length);
  const point = mean(evals.map((k) => mean(b.get(k)!) - mean(a.get(k)!)));
  const res = (xs: number[]) => xs.map(() => xs[Math.floor(r() * xs.length)]);
  const ds: number[] = [];
  for (let i = 0; i < iters; i++) ds.push(mean(evals.map((k) => mean(res(b.get(k)!)) - mean(res(a.get(k)!)))));
  ds.sort((x, y) => x - y);
  return [point, ds[Math.floor(0.025 * iters)], ds[Math.floor(0.975 * iters)]];
}

export function quality(s: Any, g: Any): number {
  if (s.kind === "autonomy") return s.hidden?.passed && Object.values(s.checks ?? {}).every(Boolean) ? 1 : 0;
  if (s.kind === "implement") return s.hidden?.passed && Object.values(s.checks ?? {}).every(Boolean) ? 1 : 0;
  return g && g.total ? g.passed / g.total : 0; // repo side effects are reported separately
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o } = parseArgs({ args: argv, options: { out: { type: "string" }, md: { type: "string" } } });
  if (!o.out) { console.error("--out DIR is required"); return 2; }
  const out = resolve(o.out);
  const spec = JSON.parse(readFileSync(join(HERE, "evals-v2.json"), "utf8"));
  const rows: Any[] = [];
  for (const ev of spec.evals) {
    const evDir = join(out, "runs", ev.id);
    if (!existsSync(evDir)) continue;
    for (const arm of readdirSync(evDir)) for (const rep of readdirSync(join(evDir, arm))) {
      const dir = join(evDir, arm, rep);
      if (!existsSync(join(dir, "score.json"))) continue;
      const s = JSON.parse(readFileSync(join(dir, "score.json"), "utf8"));
      const g = existsSync(join(dir, "grade.json")) ? JSON.parse(readFileSync(join(dir, "grade.json"), "utf8")) : null;
      rows.push({ ...s, grade: g, quality: quality(s, g) });
    }
  }
  const ORDER = ["vanilla", "claudemd", "ondemand", "v1", "v2", "v2.1", "v2.2", "v2.3", "v3", "vanilla+app", "claudemd+app", "v3+app"];
  const arms = [...new Set(rows.map((r) => r.arm))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const by = (arm: string, key: (r: Any) => number) => {
    const m = new Map<string, number[]>();
    for (const r of rows.filter((x) => x.arm === arm)) { if (!m.has(r.eval)) m.set(r.eval, []); m.get(r.eval)!.push(key(r)); }
    return m;
  };
  const lines: string[] = [];
  lines.push(`# Delivery workflow eval: ${rows.length} runs`, "");
  lines.push("## Per arm (mean over evals of per-eval means)", "");
  lines.push("Nudges = follow-up messages the simulated user had to send (repeated prompts); ended asking = share of runs whose last reply asks the user something.", "");
  lines.push("| Arm | Runs | Quality | Cost $ | Turns | Tool calls | Duration s | Nudges | Ended asking | Stop-hook feedback | Security review on auth task | Review runs that changed the repo |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  const armSummary: Any = {};
  for (const a of arms) {
    const rs = rows.filter((r) => r.arm === a);
    const perEval = (k: (r: Any) => number) => mean([...by(a, k).values()].map(mean));
    const sec = rs.filter((r) => r.eval === "impl-remember");
    armSummary[a] = {
      runs: rs.length, quality: perEval((r) => r.quality), cost: perEval((r) => r.cost_usd ?? NaN), turns: perEval((r) => r.turns ?? NaN),
      tools: perEval((r) => r.tool_calls), duration: perEval((r) => r.duration_s ?? NaN), stopFeedback: mean(rs.map((r) => r.stop_hook_feedback)),
      nudges: perEval((r) => (r.nudges ?? []).length), endedAsking: perEval((r) => (r.ended_with_question ? 1 : 0)),
      securityReviewed: sec.length ? mean(sec.map((r) => (r.security_reviewed ? 1 : 0))) : NaN,
      reviewSideEffects: `${rs.filter((r) => r.kind === "review" && !Object.values(r.checks).every(Boolean)).length}/${rs.filter((r) => r.kind === "review").length}`,
    };
    const s = armSummary[a];
    lines.push(`| ${a} | ${s.runs} | ${pct(s.quality)} | ${f(s.cost)} | ${f(s.turns, 1)} | ${f(s.tools, 1)} | ${f(s.duration, 0)} | ${f(s.nudges, 2)} | ${pct(s.endedAsking)} | ${f(s.stopFeedback, 2)} | ${pct(s.securityReviewed)} | ${s.reviewSideEffects} |`);
  }
  if (arms.includes("vanilla")) {
    lines.push("", "## Differences vs vanilla (95% bootstrap CI, stratified by eval)", "", "| Arm | Δ quality | Δ cost $ | Δ turns | Δ nudges |", "|---|---|---|---|---|");
    for (const a of arms.filter((x) => x !== "vanilla")) {
      const q = diffCI(by("vanilla", (r) => r.quality), by(a, (r) => r.quality));
      const c = diffCI(by("vanilla", (r) => r.cost_usd ?? 0), by(a, (r) => r.cost_usd ?? 0));
      const t = diffCI(by("vanilla", (r) => r.turns ?? 0), by(a, (r) => r.turns ?? 0));
      const n = diffCI(by("vanilla", (r) => (r.nudges ?? []).length), by(a, (r) => (r.nudges ?? []).length));
      armSummary[a].vsVanilla = { quality: q, cost: c, turns: t, nudges: n };
      lines.push(`| ${a} | ${f(q[0] * 100, 0)} pts [${f(q[1] * 100, 0)}, ${f(q[2] * 100, 0)}] | ${f(c[0])} [${f(c[1])}, ${f(c[2])}] | ${f(t[0], 1)} [${f(t[1], 1)}, ${f(t[2], 1)}] | ${f(n[0], 2)} [${f(n[1], 2)}, ${f(n[2], 2)}] |`);
    }
  }
  lines.push("", "## Per eval", "", "| Eval | Arm | n | Quality mean (sd) | Hidden tests pass | Checks pass | Cost $ mean (sd) | Turns | Tests changed | Notes |", "|---|---|---|---|---|---|---|---|---|---|");
  const perEval: Any = {};
  for (const ev of spec.evals) for (const a of arms) {
    const rs = rows.filter((r) => r.eval === ev.id && r.arm === a);
    if (!rs.length) continue;
    const q = rs.map((r) => r.quality), c = rs.map((r) => r.cost_usd ?? NaN);
    const hiddenRate = ev.hidden ? mean(rs.map((r) => (r.hidden?.passed ? 1 : 0))) : NaN;
    const checksRate = mean(rs.map((r) => (Object.values(r.checks).every(Boolean) ? 1 : 0)));
    const notes = [
      rs.some((r) => r.status !== "success") ? `status: ${rs.map((r) => r.status).join(",")}` : "",
      rs.some((r) => r.stop_hook_feedback) ? `hook fed back in ${rs.filter((r) => r.stop_hook_feedback).length}/${rs.length}` : "",
      ev.id === "impl-remember" ? `security-review in ${rs.filter((r) => r.security_reviewed).length}/${rs.length}` : "",
      ev.assertions ? `assertions ${rs.map((r) => (r.grade ? `${r.grade.passed}/${r.grade.total}` : "–")).join(" ")}` : "",
    ].filter(Boolean).join("; ");
    perEval[`${ev.id}/${a}`] = { n: rs.length, quality: mean(q), qualitySd: sd(q), hiddenRate, checksRate, cost: mean(c), costSd: sd(c), turns: mean(rs.map((r) => r.turns ?? NaN)) };
    lines.push(`| ${ev.id} | ${a} | ${rs.length} | ${pct(mean(q))} (${f(sd(q) * 100, 0)}) | ${ev.hidden ? pct(hiddenRate) : "n/a"} | ${pct(checksRate)} | ${f(mean(c))} (${f(sd(c))}) | ${f(mean(rs.map((r) => r.turns ?? NaN)), 1)} | ${f(mean(rs.map((r) => r.tests_changed)), 1)} | ${notes} |`);
  }
  const autoRows = rows.filter((r) => r.kind === "autonomy");
  if (autoRows.length) {
    lines.push("", "## Autonomy evals (multi-turn, simulated user)", "",
      "Nudges = follow-up messages the simulated user had to send. Quality = goal reached, hidden test passes on the shipped (or held) code, and every guardrail holds.", "",
      "| Eval | Arm | n | Goal reached | Quality | Nudges mean | No nudge needed | Approval prompts | Cost $ (all turns) | Wall s | Guardrail failures | Nudges sent |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const ev of spec.evals.filter((e: Any) => e.kind === "autonomy")) for (const a of arms) {
      const rs = autoRows.filter((r) => r.eval === ev.id && r.arm === a);
      if (!rs.length) continue;
      const guard = ["master_untouched", "no_merge", "no_tags", "no_extra_prs", "branch_convention", "todo_ticked"].flatMap((k) => { const n = rs.filter((r) => r.checks[k] === false).length; return n ? [`${k} ${n}`] : []; });
      const sent = Object.entries(rs.flatMap((r) => r.nudges).reduce((m: Any, x: string) => ((m[x] = (m[x] ?? 0) + 1), m), {})).map(([k, v]) => `${v}× "${k}"`).join(", ");
      lines.push(`| ${ev.id} | ${a} | ${rs.length} | ${rs.filter((r) => r.checks.goal_reached).length}/${rs.length} | ${pct(mean(rs.map((r) => r.quality)))} | ${f(mean(rs.map((r) => r.nudges.length)), 1)} | ${rs.filter((r) => !r.nudges.length).length}/${rs.length} | ${f(mean(rs.map((r) => r.permission_denials ?? 0)), 1)} | ${f(mean(rs.map((r) => r.cost_usd ?? NaN)))} | ${f(mean(rs.map((r) => r.wall_s)), 0)} | ${guard.join(", ") || "none"} | ${sent || "–"} |`);
    }
    const autoBy = (arm: string, key: (r: Any) => number) => { const m = new Map<string, number[]>(); for (const r of autoRows.filter((x) => x.arm === arm)) { if (!m.has(r.eval)) m.set(r.eval, []); m.get(r.eval)!.push(key(r)); } return m; };
    const autoArms = [...new Set(autoRows.map((r) => r.arm))].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
    for (const ref of ["vanilla", "claudemd", "vanilla+app", "claudemd+app"].filter((x) => autoArms.includes(x))) {
      const app = ref.endsWith("+app");
      lines.push("", `Autonomy evals, differences vs ${ref} (95% bootstrap CI, stratified by eval):`, "", "| Arm | Δ nudges | Δ quality | Δ cost $ | Δ wall s |", "|---|---|---|---|---|");
      for (const a of autoArms.filter((x) => x !== ref && x.endsWith("+app") === app && !x.startsWith("vanilla"))) {
        const n = diffCI(autoBy(ref, (r) => r.nudges.length), autoBy(a, (r) => r.nudges.length));
        const q = diffCI(autoBy(ref, (r) => r.quality), autoBy(a, (r) => r.quality));
        const c = diffCI(autoBy(ref, (r) => r.cost_usd ?? 0), autoBy(a, (r) => r.cost_usd ?? 0));
        const w = diffCI(autoBy(ref, (r) => r.wall_s), autoBy(a, (r) => r.wall_s));
        lines.push(`| ${a} | ${f(n[0], 1)} [${f(n[1], 1)}, ${f(n[2], 1)}] | ${f(q[0] * 100, 0)} pts [${f(q[1] * 100, 0)}, ${f(q[2] * 100, 0)}] | ${f(c[0])} [${f(c[1])}, ${f(c[2])}] | ${f(w[0], 0)} [${f(w[1], 0)}, ${f(w[2], 0)}] |`);
      }
    }
  }
  const graderCost = rows.reduce((s, r) => s + (r.grade?.cost_usd ?? 0), 0);
  const total = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  lines.push("", `Total session cost: $${f(total)} across ${rows.length} runs; grading: $${f(graderCost)}.`);
  const md = lines.join("\n");
  writeFileSync(join(out, "summary.json"), JSON.stringify({ arms: armSummary, perEval, total_cost: total, grader_cost: graderCost }, null, 2));
  if (o.md) writeFileSync(o.md, md + "\n");
  console.log(md);
  return 0;
}

if (import.meta.main) process.exit(await main());
