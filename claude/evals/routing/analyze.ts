#!/usr/bin/env bun
/**
 * Summarise a routing run: accuracy against the labels, wrong picks, misses, false triggers,
 * engineering wins, consistency across repetitions and cost.
 *
 * Usage: bun analyze.ts --runs DIR/runs.jsonl [--prompts prompts.json] [--json OUT.json] [--md OUT.md]
 * Full transcripts are read from DIR/runs/ (route.ts) or DIR/transcripts.jsonl.gz (the committed copy).
 *
 * Cost: sessions that ended by themselves report total_cost_usd. Sessions stopped at their first Skill
 * call report none, so their cost is estimated: cache writes and reads come exactly from the stream, output
 * tokens from the stream's thinking-token estimates plus visible text, and per-token prices are fitted
 * (least squares) on the sessions that did report a cost. The estimator is checked on those sessions too.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";

type Any = any;
const NONE = "none";
const pick = (r: Any) => r.skill ?? NONE;

/** Token features of one run: cache writes (1-hour equivalent), cache reads, output. */
export function features(r: Any): { cw: number; cr: number; out: number } {
  let cw = 0, cr = 0, outStream = 0;
  for (const u of r.usage ?? []) {
    const cc = u.cache_creation ?? {};
    const w5 = cc.ephemeral_5m_input_tokens ?? 0, w1 = cc.ephemeral_1h_input_tokens ?? 0;
    const other = Math.max(0, (u.cache_creation_input_tokens ?? 0) - w5 - w1);
    // 1-hour writes cost 2x input, 5-minute writes 1.25x: express everything as 1-hour writes.
    cw += w1 + 0.625 * (w5 + other) + 0.5 * (u.input_tokens ?? 0);
    cr += u.cache_read_input_tokens ?? 0;
    outStream += u.output_tokens ?? 0;
  }
  const mu = Object.values<Any>(r.model_usage ?? {});
  const out = mu.length ? mu.reduce((s, m) => s + (m.outputTokens ?? 0), 0) : Math.max(outStream, r.out_est ?? 0);
  return { cw, cr, out };
}

/**
 * Output tokens of a stopped run, which the stream never reports in full: the stream's thinking_tokens
 * estimates plus visible text and tool calls at `charsPerToken`.
 */
export function outputEstimate(transcript: string, charsPerToken: number): number {
  let thinking = 0, chars = 0;
  for (const line of transcript.split("\n")) {
    let e: Any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "system" && e.subtype === "thinking_tokens") thinking += e.estimated_tokens_delta ?? 0;
    if (e.type === "assistant" && !e.parent_tool_use_id) for (const b of e.message?.content ?? []) {
      if (b.type === "text") chars += b.text.length;
      if (b.type === "tool_use") chars += b.name.length + JSON.stringify(b.input).length;
    }
  }
  return thinking + chars / charsPerToken;
}

/** Least squares through the origin: cost = p_cw*cw + p_cr*cr + p_out*out, fitted on runs that reported a cost. */
export function fitPrices(rows: Any[]) {
  const pts = rows.filter((r) => r.cost_usd != null).map((r) => { const f = features(r); return { x: [f.cw, f.cr, f.out], c: r.cost_usd }; });
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const p of pts) for (let i = 0; i < 3; i++) { b[i] += p.x[i] * p.c; for (let j = 0; j < 3; j++) A[i][j] += p.x[i] * p.x[j]; }
  // Gaussian elimination on the 3x3 normal equations.
  for (let i = 0; i < 3; i++) for (let k = i + 1; k < 3; k++) { const f = A[k][i] / A[i][i]; for (let j = i; j < 3; j++) A[k][j] -= f * A[i][j]; b[k] -= f * b[i]; }
  const p = [0, 0, 0];
  for (let i = 2; i >= 0; i--) p[i] = (b[i] - A[i].slice(i + 1).reduce((s, a, j) => s + a * p[i + 1 + j], 0)) / A[i][i];
  const rel = pts.map((q) => Math.abs(q.x[0] * p[0] + q.x[1] * p[1] + q.x[2] * p[2] - q.c) / q.c).sort((x, y) => x - y);
  return { per_mtok: { cache_write_1h: p[0] * 1e6, cache_read: p[1] * 1e6, output: p[2] * 1e6 }, p, n: pts.length, medianRelErr: rel[rel.length >> 1], maxRelErr: rel[rel.length - 1] };
}

export function analyze(runs: Any[], spec: Any) {
  const P = Object.fromEntries(spec.prompts.map((p: Any) => [p.id, p]));
  runs = runs.filter((r) => P[r.id]);
  const prices = fitPrices(runs);
  const price = (r: Any) => { const f = features(r); return prices.p[0] * f.cw + prices.p[1] * f.cr + prices.p[2] * f.out; };
  for (const r of runs) { r.cost = r.cost_usd ?? price(r); r.cost_estimated = r.cost_usd == null; }
  // How good is the stopped-run estimate? Apply it to runs that did report a cost, pretending they had not.
  const check = runs.filter((r) => r.cost_usd != null && r.out_est != null).map((r) => Math.abs(price({ ...r, model_usage: null, usage: r.usage }) - r.cost_usd) / r.cost_usd).sort((a, b) => a - b);
  const estimator = { n: check.length, medianRelErr: check[check.length >> 1], p90RelErr: check[Math.floor(check.length * 0.9)] };
  const arms = [...new Set(runs.map((r) => r.arm))];
  const families = ["incident", "review"];
  const competing = (f: string) => spec.competing[f] as string[];
  const available = (arm: string, s: string) => arm === "all" || !spec.custom.includes(s);
  const summary: Any = { prices, estimator, arms: {} };
  for (const arm of arms) {
    const A: Any = (summary.arms[arm] = { families: {}, picks: {}, cost: 0, cost_estimated: 0, runs: 0, init_problems: 0, ends: {} });
    for (const r of runs.filter((r) => r.arm === arm)) {
      A.picks[pick(r)] = (A.picks[pick(r)] ?? 0) + 1;
      A.cost += r.cost; if (r.cost_estimated) A.cost_estimated += r.cost;
      A.runs++; if (r.init_problems?.length) A.init_problems++;
      A.ends[r.end] = (A.ends[r.end] ?? 0) + 1;
    }
    for (const f of families) {
      const rs = runs.filter((r) => r.arm === arm && r.family === f);
      const pos = rs.filter((r) => P[r.id].kind !== "negative"), neg = rs.filter((r) => P[r.id].kind === "negative");
      // Labels restricted to what the arm has installed; "none" stays acceptable only where labelled so.
      const acc = (r: Any) => P[r.id].acceptable.filter((s: string) => s === NONE || available(arm, s));
      const ok = (r: Any) => acc(r).includes(pick(r));
      const byKind: Any = {};
      for (const k of ["custom", "eng-fair", "ambiguous", "negative"]) {
        const ks = rs.filter((r) => P[r.id].kind === k);
        byKind[k] = { n: ks.length, ok: ks.filter(ok).length, intended: ks.filter((r) => P[r.id].intended.includes(pick(r))).length };
      }
      // A miss: no skill where a skill was the only acceptable outcome and one was installed.
      const missable = (r: Any) => !P[r.id].acceptable.includes(NONE) && acc(r).length > 0;
      A.families[f] = {
        n: rs.length, ok: rs.filter(ok).length,
        intended: pos.filter((r) => P[r.id].intended.length && P[r.id].intended.includes(pick(r))).length,
        intended_n: pos.filter((r) => P[r.id].intended.length && P[r.id].intended.every((s: string) => available(arm, s))).length,
        wrong: rs.filter((r) => r.skill && !ok(r)).map((r) => `${r.id}→${r.skill}`),
        misses: rs.filter((r) => !r.skill && missable(r)).length, missable: rs.filter(missable).length,
        false_triggers: neg.filter((r) => competing(f).includes(pick(r))).map((r) => `${r.id}→${r.skill}`), neg_n: neg.length,
        byKind,
        // How often an engineering competitor fired when it was an acceptable pick.
        eng_fair: (() => { const e = rs.filter((r) => P[r.id].acceptable.some((s: string) => s.startsWith("engineering:") && competing(f).includes(s)));
          return { n: e.length, fired: e.filter((r) => competing(f).includes(pick(r)) && pick(r).startsWith("engineering:")).length }; })(),
      };
    }
  }
  // Consistency: prompts whose repetitions all made the same pick.
  const cells: Any = {};
  for (const r of runs) (cells[`${r.id}|${r.arm}`] ??= []).push(pick(r));
  summary.consistency = Object.fromEntries(arms.map((arm) => {
    const cs = Object.entries(cells).filter(([k]) => k.endsWith(`|${arm}`)).map(([, v]) => v as string[]);
    return [arm, { prompts: cs.length, unanimous: cs.filter((v) => new Set(v).size === 1).length }];
  }));
  summary.table = spec.prompts.map((p: Any) => ({ id: p.id, family: p.family, kind: p.kind, intended: p.intended, acceptable: p.acceptable,
    ...Object.fromEntries(arms.map((arm) => [arm, runs.filter((r) => r.id === p.id && r.arm === arm).sort((a, b) => a.rep - b.rep).map(pick)])) }));
  summary.models = [...new Set(runs.map((r) => r.model))];
  summary.versions = [...new Set(runs.map((r) => r.version))];
  summary.wall_s = runs.reduce((s, r) => s + r.wall_ms, 0) / 1000;
  summary.skill_turns = runs.filter((r) => r.skill).reduce((m: Any, r) => { m[r.skill_turn] = (m[r.skill_turn] ?? 0) + 1; return m; }, {});
  return summary;
}

const short = (s: string) => s.replace(/^(sre|delivery):/, "").replace(/^engineering:/, "eng:").replace(/^code-review$/, "built-in code-review");
const cell = (v: string[]) => { const c: Record<string, number> = {}; for (const x of v) c[x] = (c[x] ?? 0) + 1; return Object.entries(c).map(([k, n]) => `${short(k)}${n > 1 ? ` ×${n}` : ""}`).join(", "); };

/** Markdown tables: per family and arm, then per prompt. */
export function markdown(s: Any): string {
  const L: string[] = [];
  const pct = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : "–");
  L.push("| Family | Arm | Acceptable pick | Intended custom skill | Wrong skill | Missed (no skill) | False triggers on negatives | Engineering skill fired where fair |", "|---|---|---|---|---|---|---|---|");
  for (const f of ["incident", "review"]) for (const [arm, A] of Object.entries<Any>(s.arms)) {
    const F = A.families[f];
    L.push(`| ${f} | ${arm} | ${pct(F.ok, F.n)} | ${arm === "all" ? pct(F.intended, F.intended_n) : "–"} | ${F.wrong.length} | ${pct(F.misses, F.missable)} | ${pct(F.false_triggers.length, F.neg_n)} | ${pct(F.eng_fair.fired, F.eng_fair.n)} |`);
  }
  L.push("", "| Prompt | Kind | Acceptable (intended first) | all | engineering-only |", "|---|---|---|---|---|");
  for (const t of s.table) {
    const acc = [...t.intended, ...t.acceptable.filter((a: string) => !t.intended.includes(a))].map(short).join(", ");
    L.push(`| ${t.id} | ${t.kind} | ${acc} | ${cell(t.all ?? [])} | ${cell(t["engineering-only"] ?? [])} |`);
  }
  return L.join("\n");
}

if (import.meta.main) {
  const { values: o } = parseArgs({ options: { runs: { type: "string" }, prompts: { type: "string" }, json: { type: "string" }, md: { type: "string" } } });
  const runs = readFileSync(o.runs!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const spec = JSON.parse(readFileSync(o.prompts ?? join(import.meta.dir, "prompts.json"), "utf8"));
  // Full transcripts sit next to runs.jsonl when available: estimate output tokens from them,
  // with characters per token calibrated on runs whose exact output count is known.
  // Either route.ts's runs/ folder or the committed transcripts.jsonl.gz ({run, event} per line).
  const gz = join(dirname(o.runs!), "transcripts.jsonl.gz"), packed = new Map<string, string[]>();
  if (existsSync(gz)) for (const l of gunzipSync(readFileSync(gz)).toString().split("\n").filter(Boolean)) {
    const { run, event } = JSON.parse(l); (packed.get(run) ?? packed.set(run, []).get(run)!).push(JSON.stringify(event));
  }
  const tr = (r: Any) => {
    const f = join(dirname(o.runs!), "runs", r.id, r.arm, `r${r.rep}.jsonl`);
    return existsSync(f) ? readFileSync(f, "utf8") : packed.get(`${r.id}/${r.arm}/r${r.rep}`)?.join("\n") ?? null;
  };
  const known = runs.filter((r) => r.model_usage && tr(r) && !(r.tools_before ?? []).some((t: string) => t === "Agent" || t === "Task"));
  const ratio = (k: number) => known.reduce((s, r) => s + Math.abs(outputEstimate(tr(r)!, k) - features(r).out), 0);
  let k = 3.5; for (const c of [2, 2.5, 3, 3.5, 4, 4.5, 5]) if (ratio(c) < ratio(k)) k = c;
  for (const r of runs) { const t = tr(r); if (t) r.out_est = outputEstimate(t, k); }
  const s = analyze(runs, spec);
  s.chars_per_token = k;
  if (o.md) writeFileSync(o.md, markdown(s) + "\n");
  const out = JSON.stringify(s, null, 1);
  if (o.json) writeFileSync(o.json, out); else console.log(out);
}
