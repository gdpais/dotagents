#!/usr/bin/env bun
/**
 * Deterministic scoring of head-to-head runs; writes score.json next to each run's meta.json.
 *
 * Usage: bun score.ts --out DIR [--force]
 *
 * Every run: cost, wall time, turns, forced-skill check, the deliverable (final answer of each turn, files
 * the session wrote, and for the built-in /code-review the findings it reported through ReportFindings,
 * which the app renders as cards) and its word counts.
 * Review runs: repo left unchanged (HEAD, branch, clean tree); file:line citations parsed from the
 * deliverable, checked against the branch's files (exists, line in range) and matched to planted defects
 * (same file, within LINE_TOL lines).
 * Incident runs: whether the key figures appear, an "MTTR" label, and whether the logs were converted
 * (a parse_logs step or a .jsonl written), which is a house rule.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = import.meta.dir;
type Any = any;
export const LINE_TOL = 3;

const sh = (cmd: string[], cwd: string) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return p.stdout.toString().trim();
};
export const words = (t: string) => (t.match(/\S+/g) ?? []).length;

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    if (n === ".git" || n === "node_modules") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p, base)); else out.push(relative(base, p));
  }
  return out;
}

/** Files the session wrote or changed in its working folder, compared with the fixture it started from. */
export function writtenFiles(work: string, fixture: string | null): { path: string; text: string }[] {
  if (!existsSync(work)) return [];
  const res: { path: string; text: string }[] = [];
  for (const f of walk(work)) {
    const orig = fixture ? join(fixture, f) : null;
    const now = readFileSync(join(work, f));
    if (orig && existsSync(orig) && Buffer.compare(readFileSync(orig), now) === 0) continue;
    res.push({ path: f, text: now.length > 200_000 ? `(${now.length} bytes, not shown)` : now.toString() });
  }
  return res;
}

/** ReportFindings calls (the built-in /code-review) rendered as the list the app shows. */
export function reportedFindings(transcript: string): string {
  const out: string[] = [];
  for (const l of transcript.split("\n")) {
    let e: Any; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== "assistant") continue;
    for (const b of e.message?.content ?? []) if (b.type === "tool_use" && b.name === "ReportFindings")
      for (const f of b.input?.findings ?? []) out.push(`- ${f.file}:${f.line} [${f.category ?? ""}] ${f.summary ?? f.short_summary ?? ""}${f.failure_scenario ? ` Failure scenario: ${f.failure_scenario}` : ""}`);
  }
  return out.length ? `Findings reported:\n${out.join("\n")}` : "";
}

const CITE = /([\w./-]+\.(?:py|ts|tsx|js))(?::(\d+)(?:[-–](\d+))?|#L(\d+)|,? lines? (\d+)(?:[-–](\d+))?)/g;
/** file:line citations in a review answer, checked against the repo and matched to planted defects. */
export function citations(text: string, repo: string, defects: Any[]) {
  const cites: { file: string; from: number; to: number; valid: boolean; defects: string[] }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CITE)) {
    const file = m[1].replace(/^\.\//, "").replace(/^(a|b)\//, "");
    const from = Number(m[2] ?? m[4] ?? m[5]), to = Number(m[3] ?? m[6] ?? from);
    const k = `${file}:${from}-${to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const path = join(repo, file);
    const n = existsSync(path) ? readFileSync(path, "utf8").split("\n").length : 0;
    const valid = n > 0 && from >= 1 && to <= n && from <= to;
    // Adjacent defects can share a citation, so this is a loose, upper-bound match; the graders decide recall.
    const ds = defects.filter((d) => d.file === file && from <= d.line + LINE_TOL && to >= d.line - LINE_TOL).map((d) => d.id);
    cites.push({ file, from, to, valid, defects: ds });
  }
  return cites;
}

/** Key figures that should appear in an incident answer (formatted with or without thousands separators). */
export function figuresPresent(text: string, figs: Record<string, number>) {
  const t = text.replace(/(\d),(\d{3})/g, "$1$2");
  return Object.fromEntries(Object.entries(figs).map(([k, v]) => [k, new RegExp(`(^|[^\\d.])${String(v).replace(".", "\\.")}([^\\d]|$)`).test(t)]));
}

export function keyFigures(evId: string, key: Any): Record<string, number> {
  const f = key.figures ?? {};
  if (evId === "inc-small") return { failed_503: f.edge01_checkout_503_in_window, denominator: f.edge01_checkout_requests_in_window_1152_1231_UTC };
  if (evId.startsWith("inc-2219")) return { failed: f.confirm_failed_in_window, denominator: f.confirm_requests_in_window_both_edges_corrected, failed_503: f.confirm_503_in_window };
  return {};
}

export function scoreRun(dir: string, out: string, spec: Any) {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const ev = spec.evals.find((e: Any) => e.id === meta.eval);
  const transcript = existsSync(join(dir, "transcript.jsonl")) ? readFileSync(join(dir, "transcript.jsonl"), "utf8") : "";
  const work = join(dir, "work");
  const finals = meta.turns.map((t: Any) => t.text ?? "");
  const s: Any = { eval: meta.eval, family: meta.family, arm: meta.arm, rep: meta.rep, model: meta.model, forced_ok: meta.forced_ok,
    code_review_level: meta.code_review_level ?? null, cost_usd: meta.cost_usd, wall_s: meta.wall_ms / 1000,
    turns: meta.turns.map((t: Any) => t.turns), final_words: finals.map(words), ended: meta.turns.map((t: Any) => t.subtype) };
  const findings = reportedFindings(transcript);
  if (ev.family === "review") {
    const key = JSON.parse(readFileSync(join(HERE, "keys", "review_key.json"), "utf8"))[ev.id];
    const fixture = join(out, "fixtures", ev.fixture);
    s.repo_unchanged = existsSync(work) && sh(["git", "rev-parse", "HEAD"], work) === sh(["git", "rev-parse", "HEAD"], fixture)
      && sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], work) === key.branch && sh(["git", "status", "--porcelain"], work) === "";
    s.deliverable = [finals.join("\n\n"), findings].filter(Boolean).join("\n\n");
    const cites = citations(s.deliverable, work, key.defects);
    s.citations = { total: cites.length, valid: cites.filter((c) => c.valid).length, invalid: cites.filter((c) => !c.valid).map((c) => `${c.file}:${c.from}`) };
    s.planted = key.defects.length;
    s.near_citation = [...new Set(cites.flatMap((c) => c.defects))].sort();
  } else {
    const fixture = ev.fixture ? join(out, "fixtures", ev.fixture) : null;
    const t2 = ev.turn2 ? join(out, "fixtures", ev.turn2.add) : null;
    let files = writtenFiles(work, fixture);
    if (t2) files = files.filter((f) => !(existsSync(join(t2, f.path)) && readFileSync(join(t2, f.path)).equals(readFileSync(join(work, f.path)))));
    const docs = files.filter((f) => /\.(md|txt|eml|html)$/i.test(f.path));
    s.files_written = files.map((f) => f.path);
    s.logs_converted = files.some((f) => /\.jsonl$/i.test(f.path)) || /parse_logs/.test(transcript);
    s.deliverable = [ev.turn2 ? finals.map((t: string, i: number) => `=== Turn ${i + 1} answer ===\n${t}`).join("\n\n") : finals.join("\n\n"),
      ...docs.map((f) => `=== File written: ${f.path} ===\n${f.text}`)].join("\n\n");
    s.doc_words = Object.fromEntries(docs.map((f) => [f.path, words(f.text)]));
    const key = JSON.parse(readFileSync(join(HERE, "keys", `${ev.key}.json`), "utf8"));
    s.key_figures = figuresPresent(s.deliverable, keyFigures(ev.id, key));
    s.mttr_label = /\bMTTR\b|mean time to/i.test(s.deliverable);
  }
  s.deliverable_words = words(s.deliverable);
  writeFileSync(join(dir, "score.json"), JSON.stringify(s, null, 2));
  return s;
}

export function runDirs(out: string): string[] {
  const dirs: string[] = [];
  const root = join(out, "runs");
  if (!existsSync(root)) return dirs;
  for (const ev of readdirSync(root)) for (const arm of readdirSync(join(root, ev))) for (const rep of readdirSync(join(root, ev, arm))) {
    const d = join(root, ev, arm, rep);
    if (existsSync(join(d, "meta.json"))) dirs.push(d);
  }
  return dirs;
}

if (import.meta.main) {
  const { values: o } = parseArgs({ options: { out: { type: "string" }, force: { type: "boolean" } } });
  const out = resolve(o.out!);
  const spec = JSON.parse(readFileSync(join(HERE, "evals.json"), "utf8"));
  let n = 0;
  for (const d of runDirs(out)) if (o.force || !existsSync(join(d, "score.json"))) { scoreRun(d, out, spec); n++; }
  console.log(`scored ${n} run(s)`);
}
