#!/usr/bin/env bun
/**
 * Blind grading of head-to-head deliverables by separate headless sessions (default 3 Sonnet graders,
 * majority vote). A grader sees the request, the answer key and the deliverable, with skill, plugin and
 * helper-script names masked. It never sees the arm, the transcript or the session's folder. Output
 * format can still give an arm away (the built-in /code-review's findings list, the custom skills'
 * fixed headings): that is a stated limit.
 *
 * Usage: bun grade.ts --out DIR [--model sonnet] [--votes 3] [--concurrency 6] [--force] [--evals id,...]
 *
 * Incident runs: each assertion in evals.json passes or fails; the verdict is the majority.
 * Review runs: per planted defect found or not (majority); every finding classified as planted / other
 * real issue / false positive / style-only (counts: median across graders); house assertions (majority).
 * Writes grade.json next to score.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { majority, parseVerdicts } from "../harness/grade";
import { runDirs } from "./score";

const HERE = import.meta.dir;
type Any = any;

const MASK = /\b(defect-first-review|rca-investigation|incident-live-report|incident-postmortem|sre-incident-lifecycle|tech-email|incident-response|(?:engineering|sre|delivery):[\w-]+|code-review|ReportFindings|parse_logs(?:\.ts)?|evidence_inventory(?:\.ts)?)\b/g;
export function mask(text: string): string {
  return text.replace(/^.*\bskills? used\b.*$/gim, "").replace(MASK, "[tool]").replace(/\/[\w./-]*(scratchpad|\.claude)[\w./-]*/g, "<path>");
}

const sh = (cmd: string[], cwd: string) => Bun.spawnSync(cmd, { cwd, stdout: "pipe" }).stdout.toString();
/** The change under review as the grader sees it: the diff plus the changed files numbered as on the branch. */
export function changeContext(repo: string): string {
  const diff = sh(["git", "diff", "-U4", "main...HEAD"], repo);
  const files = sh(["git", "diff", "--name-only", "main...HEAD"], repo).split("\n").filter(Boolean);
  const numbered = files.map((f) => `--- ${f} (branch version, numbered)\n` + readFileSync(join(repo, f), "utf8").split("\n").map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join("\n"));
  return `${diff}\n\n${numbered.join("\n\n")}`;
}

export function incidentPrompt(ev: Any, key: Any, answer: string): string {
  const req = ev.turn2 ? `Turn 1: ${ev.prompt}\nTurn 2 (after more evidence was added): ${ev.turn2.prompt}` : ev.prompt;
  return [
    "You are grading an AI assistant's incident-response deliverable against a hidden answer key. Judge only what the deliverable says.",
    "Be strict: an assertion passes only if the deliverable clearly satisfies it. Do not reward length or tone. The answer key lists the facts that are in the evidence; anything stated as fact beyond them is invented unless it is clearly labelled as a proposal, placeholder or unknown.",
    "Figures: a count or rate passes if it matches the key's figure for the same window, or one of the key's alternative windows, or is consistent with a window the deliverable states explicitly (within about 2%). Inferences derived from the evidence (for example a percentile computed from the logs) are not invented facts.",
    "", "## User request", req, "", "## Answer key (hidden from the assistant)", JSON.stringify(key, null, 1), "",
    "## Deliverable", "<<<", answer, ">>>", "", "## Assertions", ...ev.assertions.map((a: string, i: number) => `${i + 1}. ${a}`), "",
    'Reply with ONLY a JSON array, one object per assertion in order: [{"n": 1, "pass": true, "evidence": "short quote or reason"}]',
  ].join("\n");
}

export function reviewPrompt(ev: Any, key: Any, change: string, answer: string): string {
  return [
    "You are grading an AI assistant's code review against a hidden answer key of planted defects. Judge only what the review says.",
    "A planted defect counts as found only if the review identifies that problem (the same failure, not just the same line). Classify every distinct finding in the review:",
    '"planted:Dn" (it is planted defect Dn), "real" (a genuine problem in the changed code that is not planted), "false_positive" (wrong, not a problem, or not in this change), or "style" (naming, formatting, docs, tests wanted, or other non-defects). Treat requests for tests as "style".',
    "", "## User request", ev.prompt, "", "## The change under review", change, "", "## Answer key (hidden from the reviewer)", JSON.stringify(key, null, 1), "",
    "## Review", "<<<", answer, ">>>", "", "## House assertions", ...ev.house.map((a: string, i: number) => `${i + 1}. ${a}`), "",
    "Reply with ONLY a JSON object:",
    `{"defects": [${key.defects.map((d: Any) => `{"id": "${d.id}", "found": true, "evidence": "..."}`).join(", ")}], "findings": [{"finding": "short", "class": "planted:D1"}], "house": [{"n": 1, "pass": true, "evidence": "..."}]}`,
  ].join("\n");
}

async function ask(prompt: string, model: string, cwd: string): Promise<{ text: string; cost: number | null }> {
  // A bare grader: no tools, skills, MCP servers, settings or Claude Code system prompt (about 1k tokens of overhead).
  const p = Bun.spawn(["claude", "-p", prompt, "--model", model, "--output-format", "json", "--tools", "",
    "--system-prompt", "You are a strict, careful grader. Follow the instructions in the user message exactly and reply only in the format asked.",
    "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"],
    { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  try { const r = JSON.parse(out); return { text: String(r.result ?? ""), cost: r.total_cost_usd ?? null }; } catch { return { text: "", cost: null }; }
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };

export function parseReview(text: string, key: Any, nHouse: number) {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const defects = Object.fromEntries(key.defects.map((d: Any) => [d.id, !!(o.defects ?? []).find((x: Any) => x.id === d.id)?.found]));
    const findings = (o.findings ?? []).map((f: Any) => ({ finding: String(f.finding ?? ""), class: String(f.class ?? "") }));
    const house = parseVerdicts(JSON.stringify(o.house ?? []), nHouse);
    if (!house) return null;
    return { defects, findings, house };
  } catch { return null; }
}

async function gradeRun(dir: string, out: string, spec: Any, model: string, votes: number) {
  const s = JSON.parse(readFileSync(join(dir, "score.json"), "utf8"));
  const ev = spec.evals.find((e: Any) => e.id === s.eval);
  const cwd = join(out, "grader-tmp");
  mkdirSync(cwd, { recursive: true });
  const answer = mask(s.deliverable || "(no answer)");
  if (ev.family === "incident") {
    const key = JSON.parse(readFileSync(join(HERE, "keys", `${ev.key}.json`), "utf8"));
    const prompt = incidentPrompt(ev, key, answer);
    const res = await Promise.all(Array.from({ length: votes }, async () => {
      for (let a = 0; a < 2; a++) { const r = await ask(prompt, model, cwd); const v = parseVerdicts(r.text, ev.assertions.length); if (v) return { v, cost: r.cost }; }
      return null;
    }));
    const ok = res.filter(Boolean) as Any[];
    if (!ok.length) return { error: "no valid grader output" };
    const verdicts = majority(ok.map((r) => r.v), ev.assertions.length).map((v, i) => ({ ...v, assertion: ev.assertions[i] }));
    const kind = (t: string) => verdicts.filter((v) => v.assertion.startsWith(`[${t}]`));
    return { model, votes: ok.length, cost_usd: ok.reduce((a, r) => a + (r.cost ?? 0), 0), verdicts,
      substance: { passed: kind("Substance").filter((v) => v.pass).length, total: kind("Substance").length },
      house: { passed: kind("House").filter((v) => v.pass).length, total: kind("House").length } };
  }
  const key = JSON.parse(readFileSync(join(HERE, "keys", "review_key.json"), "utf8"))[ev.id];
  const prompt = reviewPrompt(ev, key, changeContext(join(out, "fixtures", ev.fixture)), answer);
  const res = await Promise.all(Array.from({ length: votes }, async () => {
    for (let a = 0; a < 2; a++) { const r = await ask(prompt, model, cwd); const p = parseReview(r.text, key, ev.house.length); if (p) return { ...p, cost: r.cost }; }
    return null;
  }));
  const ok = res.filter(Boolean) as Any[];
  if (!ok.length) return { error: "no valid grader output" };
  const found = Object.fromEntries(key.defects.map((d: Any) => [d.id, ok.filter((r) => r.defects[d.id]).length * 2 > ok.length]));
  const count = (cls: (c: string) => boolean) => median(ok.map((r) => r.findings.filter((f: Any) => cls(f.class)).length));
  const house = majority(ok.map((r) => r.house), ev.house.length).map((v, i) => ({ ...v, assertion: ev.house[i] }));
  return { model, votes: ok.length, cost_usd: ok.reduce((a, r) => a + (r.cost ?? 0), 0),
    found, recall: key.defects.length ? Object.values(found).filter(Boolean).length / key.defects.length : null,
    false_positives: count((c) => c === "false_positive"), other_real: count((c) => c === "real"), style: count((c) => c === "style"),
    findings: ok[0].findings, house, house_passed: house.filter((v) => v.pass).length, house_total: house.length };
}

if (import.meta.main) {
  const { values: o } = parseArgs({ options: { out: { type: "string" }, model: { type: "string" }, votes: { type: "string" }, concurrency: { type: "string" }, force: { type: "boolean" }, evals: { type: "string" } } });
  const out = resolve(o.out!);
  const spec = JSON.parse(readFileSync(join(HERE, "evals.json"), "utf8"));
  const only = o.evals?.split(",");
  const jobs = runDirs(out).filter((d) => existsSync(join(d, "score.json")) && (o.force || !existsSync(join(d, "grade.json")))
    && (!only || only.includes(JSON.parse(readFileSync(join(d, "score.json"), "utf8")).eval)));
  let next = 0, done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const d = jobs[next++];
      const g = await gradeRun(d, out, spec, o.model ?? "sonnet", Number(o.votes ?? 3));
      writeFileSync(join(d, "grade.json"), JSON.stringify(g, null, 2));
      const sum = g.error ? g.error : g.substance ? `substance ${g.substance.passed}/${g.substance.total}, house ${g.house.passed}/${g.house.total}` : `recall ${g.recall ?? "-"}, FP ${g.false_positives}, house ${g.house_passed}/${g.house_total}`;
      console.log(`[${++done}/${jobs.length}] ${d.split("/runs/")[1]}: ${sum} ($${(g.cost_usd ?? 0).toFixed(3)})`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Number(o.concurrency ?? 6), jobs.length) }, worker));
}
