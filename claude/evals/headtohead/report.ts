#!/usr/bin/env bun
/**
 * Head-to-head report: per family and arm, substance first, house rules apart, cost and time per run,
 * and differences with 95% bootstrap CIs stratified by eval (the harness's diffCI).
 *
 * Usage: bun report.ts --out DIR [--md FILE] [--json FILE] [--grading-cost]
 *
 * Incident quality: share of [Substance] assertions passed (majority of graders); house share apart.
 * Review quality: recall of planted defects (repos with defects), false positives per run (all repos,
 * clean repo shown apart), other real issues, style-only findings, citation validity (deterministic).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { diffCI } from "../harness/report";
import { runDirs } from "./score";

type Any = any;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–");
const ci = ([p, lo, hi]: [number, number, number], fmt: (x: number) => string) => `${fmt(p)} [${fmt(lo)}, ${fmt(hi)}]`;
const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
const usd = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(3)}`;

export function load(out: string) {
  return runDirs(out).filter((d) => existsSync(join(d, "score.json"))).map((d) => {
    const s = JSON.parse(readFileSync(join(d, "score.json"), "utf8"));
    const g = existsSync(join(d, "grade.json")) ? JSON.parse(readFileSync(join(d, "grade.json"), "utf8")) : null;
    const r: Any = { ...s, grade: g && !g.error ? g : null };
    if (s.family === "incident" && r.grade) { r.substance = g.substance.passed / g.substance.total; r.house = g.house.passed / g.house.total; }
    if (s.family === "review" && r.grade) {
      r.recall = g.recall; r.fp = g.false_positives; r.other_real = g.other_real; r.style = g.style; r.house = g.house_passed / g.house_total;
      r.cite_valid = s.citations.total ? s.citations.valid / s.citations.total : NaN;
    }
    return r;
  });
}

const byEval = (rows: Any[], arm: string, metric: (r: Any) => number) => {
  const m = new Map<string, number[]>();
  for (const r of rows.filter((r) => r.arm === arm)) { const v = metric(r); if (Number.isFinite(v)) (m.get(r.eval) ?? m.set(r.eval, []).get(r.eval)!).push(v); }
  return m;
};

export function report(rows: Any[], gradingCost: number | null) {
  const L: string[] = [];
  const summary: Any = { families: {} };
  const fams: Record<string, string[]> = { incident: ["none", "engineering", "custom"], review: ["none", "engineering", "builtin", "custom"] };
  for (const [fam, arms] of Object.entries(fams)) {
    const rs = rows.filter((r) => r.family === fam && r.grade);
    if (!rs.length) continue;
    const S: Any = (summary.families[fam] = { arms: {}, diffs: {} });
    L.push(`### ${fam === "incident" ? "Incident" : "Code review"}`, "");
    if (fam === "incident") {
      L.push("| Arm | Runs | Substance | House rules | Cost per run | Time per run | Substance per $ |", "|---|---|---|---|---|---|---|");
      for (const a of arms) {
        const x = rs.filter((r) => r.arm === a);
        if (!x.length) continue;
        const A = (S.arms[a] = { runs: x.length, substance: mean(x.map((r) => r.substance)), house: mean(x.map((r) => r.house)), cost: mean(x.map((r) => r.cost_usd)), wall_s: mean(x.map((r) => r.wall_s)) });
        L.push(`| ${a} | ${A.runs} | ${pct(A.substance)} | ${pct(A.house)} | $${f(A.cost, 3)} | ${Math.round(A.wall_s)} s | ${f(A.substance / A.cost, 2)} |`);
      }
      L.push("", "| Comparison | Substance (points) | House (points) | Cost per run |", "|---|---|---|---|");
      for (const [a, b] of [["none", "engineering"], ["none", "custom"], ["engineering", "custom"]]) {
        if (!S.arms[a] || !S.arms[b]) continue;
        const d = { substance: diffCI(byEval(rs, a, (r) => r.substance), byEval(rs, b, (r) => r.substance)), house: diffCI(byEval(rs, a, (r) => r.house), byEval(rs, b, (r) => r.house)),
          cost: diffCI(byEval(rs, a, (r) => r.cost_usd), byEval(rs, b, (r) => r.cost_usd)) };
        S.diffs[`${b} vs ${a}`] = d;
        L.push(`| ${b} vs ${a} | ${ci(d.substance, pts)} | ${ci(d.house, pts)} | ${ci(d.cost, usd)} |`);
      }
      L.push("", "Substance by eval (share of substance assertions passed, mean over runs):", "", `| Eval | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`);
      for (const ev of [...new Set(rs.map((r) => r.eval))]) L.push(`| ${ev} | ${arms.map((a) => { const x = rs.filter((r) => r.eval === ev && r.arm === a); return x.length ? `${pct(mean(x.map((r) => r.substance)))} ($${f(mean(x.map((r) => r.cost_usd)), 2)})` : "–"; }).join(" | ")} |`);
    } else {
      L.push("| Arm | Runs | Planted-defect recall | False positives per run | FP on the clean change | Other real issues | Style-only | Valid citations | House rules | Cost per run | Time per run |", "|---|---|---|---|---|---|---|---|---|---|---|");
      for (const a of arms) {
        const x = rs.filter((r) => r.arm === a);
        if (!x.length) continue;
        const withDefects = x.filter((r) => r.recall != null), clean = x.filter((r) => r.eval === "rv-clean");
        const A = (S.arms[a] = { runs: x.length, recall: mean(withDefects.map((r) => r.recall)), fp: mean(x.map((r) => r.fp)), fp_clean: mean(clean.map((r) => r.fp)),
          other_real: mean(x.map((r) => r.other_real)), style: mean(x.map((r) => r.style)), cite_valid: mean(x.map((r) => r.cite_valid).filter(Number.isFinite)),
          house: mean(x.map((r) => r.house)), cost: mean(x.map((r) => r.cost_usd)), wall_s: mean(x.map((r) => r.wall_s)), level: [...new Set(x.map((r) => r.code_review_level).filter(Boolean))] });
        L.push(`| ${a}${A.level.length ? ` (${A.level.join("/")})` : ""} | ${A.runs} | ${pct(A.recall)} | ${f(A.fp, 2)} | ${f(A.fp_clean, 2)} | ${f(A.other_real, 1)} | ${f(A.style, 1)} | ${pct(A.cite_valid)} | ${pct(A.house)} | $${f(A.cost, 3)} | ${Math.round(A.wall_s)} s |`);
      }
      L.push("", "| Comparison | Recall (points) | False positives per run | Cost per run |", "|---|---|---|---|");
      for (const [a, b] of [["none", "engineering"], ["none", "builtin"], ["none", "custom"], ["builtin", "custom"], ["engineering", "custom"]]) {
        if (!S.arms[a] || !S.arms[b]) continue;
        const d = { recall: diffCI(byEval(rs, a, (r) => r.recall ?? NaN), byEval(rs, b, (r) => r.recall ?? NaN)), fp: diffCI(byEval(rs, a, (r) => r.fp), byEval(rs, b, (r) => r.fp)),
          cost: diffCI(byEval(rs, a, (r) => r.cost_usd), byEval(rs, b, (r) => r.cost_usd)) };
        S.diffs[`${b} vs ${a}`] = d;
        L.push(`| ${b} vs ${a} | ${ci(d.recall, pts)} | ${ci(d.fp, (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`)} | ${ci(d.cost, usd)} |`);
      }
      L.push("", "Recall and false positives by repo (mean over runs):", "", `| Repo | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`);
      for (const ev of [...new Set(rs.map((r) => r.eval))]) L.push(`| ${ev} | ${arms.map((a) => { const x = rs.filter((r) => r.eval === ev && r.arm === a); return x.length ? `${ev === "rv-clean" ? "–" : pct(mean(x.map((r) => r.recall)))} / FP ${f(mean(x.map((r) => r.fp)), 1)}` : "–"; }).join(" | ")} |`);
      // Which planted defects each arm missed most.
      const miss: Record<string, Record<string, number>> = {};
      for (const r of rs) for (const [d, ok] of Object.entries<boolean>(r.grade.found ?? {})) if (!ok) { (miss[r.arm] ??= {})[`${r.eval}:${d}`] = ((miss[r.arm] ?? {})[`${r.eval}:${d}`] ?? 0) + 1; }
      S.missed = miss;
    }
    L.push("");
  }
  const all = rows;
  summary.sessions = { runs: all.length, cost: all.reduce((s, r) => s + (r.cost_usd ?? 0), 0), wall_s: all.reduce((s, r) => s + r.wall_s, 0), models: [...new Set(all.map((r) => r.model))],
    forced_not_confirmed: all.filter((r) => !r.forced_ok).map((r) => `${r.eval}/${r.arm}/r${r.rep}`), grading_cost: gradingCost,
    review_repo_changed: all.filter((r) => r.family === "review" && r.repo_unchanged === false).map((r) => `${r.eval}/${r.arm}/r${r.rep}`) };
  return { md: L.join("\n"), summary };
}

if (import.meta.main) {
  const { values: o } = parseArgs({ options: { out: { type: "string" }, md: { type: "string" }, json: { type: "string" } } });
  const out = resolve(o.out!);
  const rows = load(out);
  const gradingCost = runDirs(out).map((d) => join(d, "grade.json")).filter(existsSync).reduce((s, p) => s + (JSON.parse(readFileSync(p, "utf8")).cost_usd ?? 0), 0);
  const { md, summary } = report(rows, gradingCost);
  if (o.md) writeFileSync(o.md, md + "\n"); else console.log(md);
  if (o.json) writeFileSync(o.json, JSON.stringify(summary, null, 1));
  console.error(`runs ${summary.sessions.runs}, session cost $${summary.sessions.cost.toFixed(2)}, grading $${(gradingCost ?? 0).toFixed(2)}, not confirmed: ${summary.sessions.forced_not_confirmed.length}`);
}
