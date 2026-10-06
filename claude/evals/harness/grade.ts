#!/usr/bin/env bun
/**
 * Blind grading of review-eval answers. The grader is a separate headless Claude
 * session that sees only the user's request, the final answer (with workflow and
 * script names masked so it can't tell which setup produced it) and the
 * assertions. It never sees the repo, the transcript or the arm.
 *
 * Usage: bun grade.ts --out DIR [--model sonnet] [--votes 3] [--concurrency 6] [--force]
 * Each assertion's verdict is the majority of --votes independent grader sessions.
 * Writes grade.json next to score.json for every review run.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = import.meta.dir;
const MASK = /\b(delivery-lifecycle|delivery:[\w-]+|preflight(\.ts)?|classify_change(\.ts)?|quality_gate(\.ts)?|scan_secrets(\.ts)?|release_plan(\.ts)?|bench_stats(\.ts)?|audit_ci(\.ts)?|performance-review|ci-cd-pipeline|feature-planning|stop hook|Stop hook)\b/g;

export function mask(text: string): string {
  return text.replace(MASK, "[tool]").replace(/\/[\w./-]*scratchpad[\w./-]*/g, "<path>");
}

export function graderPrompt(request: string, answer: string, assertions: string[]): string {
  return [
    "You are grading an AI coding assistant's answer for a software task. Judge only what the answer itself says.",
    "Be strict: an assertion passes only if the answer clearly satisfies it. Do not reward length or tone.",
    "", "## User request", request, "", "## Answer", "<<<", answer, ">>>", "", "## Assertions",
    ...assertions.map((a, i) => `${i + 1}. ${a}`), "",
    'Reply with ONLY a JSON array, one object per assertion in order: [{"n": 1, "pass": true, "evidence": "short quote or reason"}]',
  ].join("\n");
}

export function parseVerdicts(text: string, count: number): { n: number; pass: boolean; evidence: string }[] | null {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) && arr.length === count ? arr.map((x: any, i: number) => ({ n: i + 1, pass: x.pass === true, evidence: String(x.evidence ?? "") })) : null;
  } catch { return null; }
}

/** Majority vote over independent grader sessions; ties count as fail (strict). */
export function majority(votes: { pass: boolean; evidence: string }[][], count: number) {
  return Array.from({ length: count }, (_, i) => {
    const vs = votes.map((v) => v[i]).filter(Boolean);
    const yes = vs.filter((v) => v.pass).length;
    return { n: i + 1, pass: yes * 2 > vs.length, votes: `${yes}/${vs.length}`, evidence: (vs.find((v) => v.pass === yes * 2 > vs.length) ?? vs[0])?.evidence ?? "" };
  });
}

async function grade(dir: string, ev: any, model: string, votes: number) {
  const runs = await Promise.all(Array.from({ length: votes }, () => gradeOnce(dir, ev, model)));
  const ok = runs.filter((r) => !(r as any).error);
  if (!ok.length) return runs[0];
  const verdicts = majority(ok.map((r) => r.verdicts), ev.assertions.length);
  return { model, votes: ok.length, cost_usd: ok.reduce((s, r) => s + (r.cost_usd ?? 0), 0), verdicts, passed: verdicts.filter((v) => v.pass).length, total: verdicts.length };
}

async function gradeOnce(dir: string, ev: any, model: string): Promise<any> {
  const score = JSON.parse(readFileSync(join(dir, "score.json"), "utf8"));
  const prompt = graderPrompt(ev.prompt, mask(score.final_text || "(no answer)"), ev.assertions);
  const cwd = mkdtempSync(join(tmpdir(), "grader-"));
  for (let attempt = 1; attempt <= 2; attempt++) {
    const p = Bun.spawn(["claude", "-p", prompt, "--model", model, "--output-format", "json", "--disallowedTools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "Agent", "Task", "WebFetch", "WebSearch", "Skill"],
      { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    let res: any = {};
    try { res = JSON.parse(out); } catch { /* retry */ }
    const verdicts = parseVerdicts(String(res.result ?? ""), ev.assertions.length);
    if (verdicts) return { model, attempt, cost_usd: res.total_cost_usd ?? null, verdicts, passed: verdicts.filter((v) => v.pass).length, total: verdicts.length };
  }
  return { model, error: "grader did not return valid JSON", verdicts: [], passed: 0, total: ev.assertions.length };
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o } = parseArgs({ args: argv, options: { out: { type: "string" }, model: { type: "string" }, concurrency: { type: "string" }, force: { type: "boolean" }, votes: { type: "string" } } });
  if (!o.out) { console.error("--out DIR is required"); return 2; }
  const out = resolve(o.out);
  const spec = JSON.parse(readFileSync(join(HERE, "evals-v2.json"), "utf8"));
  const jobs: { dir: string; ev: any }[] = [];
  for (const ev of spec.evals.filter((e: any) => e.assertions?.length)) {
    const evDir = join(out, "runs", ev.id);
    if (!existsSync(evDir)) continue;
    for (const arm of readdirSync(evDir)) for (const rep of readdirSync(join(evDir, arm))) {
      const dir = join(evDir, arm, rep);
      if (existsSync(join(dir, "score.json")) && (o.force || !existsSync(join(dir, "grade.json")))) jobs.push({ dir, ev });
    }
  }
  let next = 0, done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const g = await grade(j.dir, j.ev, o.model ?? "sonnet", Number(o.votes ?? 3));
      writeFileSync(join(j.dir, "grade.json"), JSON.stringify(g, null, 2));
      console.log(`[${++done}/${jobs.length}] ${j.dir.split("/runs/")[1]}: ${g.passed}/${g.total}${(g as any).error ? " " + (g as any).error : ""}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Number(o.concurrency ?? 6), jobs.length) }, worker));
  return 0;
}

if (import.meta.main) process.exit(await main());
