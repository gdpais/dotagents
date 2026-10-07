#!/usr/bin/env bun
/**
 * One-call delivery check: classify the change, run the repository's own quality
 * commands, scan the diff for secrets, and audit CI files when they changed.
 * Prints a short summary (or JSON with --json) so the model reads one result
 * instead of orchestrating five scripts.
 *
 * Usage: preflight.ts [-C PATH] [--base BRANCH | --range RANGE] [--run KINDS|none]
 *                     [--timeout SECONDS] [--json]
 *   target   default: uncommitted changes (staged, unstaged, untracked) against HEAD
 *   --run    quality kinds to execute, comma list of format,lint,typecheck,test,build;
 *            default from .claude/delivery.json `preflight.run`, else lint,typecheck,test
 *   --timeout per command, default 300
 *
 * Blocking results (exit 1): a failed quality command, a high-confidence secret,
 * a high CI finding on a changed workflow. Review gates that need judgment
 * (security, performance, migrations) are listed under `reviews`, not failures; `strong`
 * marks the ones backed by a risky code pattern or a configured path.
 * Exit 2 on errors. Running the quality kinds executes the repo's commands.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { classifyRepo, type Classified } from "./classify_change";
import { detect, KINDS, runCommand, type Kind } from "./quality_gate";
import { scanPatch, type Finding } from "./scan_secrets";

export interface Review { gate: string; skill: string; why: string; strong: boolean }
export interface Preflight {
  ok: boolean;
  target: Record<string, string>;
  size: string;
  totals: Classified["totals"];
  quality: { kind: string; command: string; passed: boolean; exit_code: number; timed_out: boolean; no_tests: boolean; duration_s: number; output_tail: string }[];
  not_detected: string[];
  secrets: Finding[];
  ci: { id: string; level: string; file: string; job?: string; message: string }[];
  reviews: Review[];
  advisories: string[];
  blocking: string[];
}

const REVIEW_SKILL: Record<string, string> = {
  security: "security-review",
  performance: "performance-review",
  migrations: "engineering:deploy-checklist",
  infra: "ci-cd-pipeline",
};

async function git(args: string[], cwd: string): Promise<string | null> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out : null;
}

function configuredKinds(top: string | null): Kind[] | null {
  if (!top) return null;
  const path = join(top, ".claude", "delivery.json");
  if (!existsSync(path)) return null;
  try {
    const run = JSON.parse(readFileSync(path, "utf8"))?.preflight?.run;
    return Array.isArray(run) ? run.filter((k: string) => (KINDS as readonly string[]).includes(k)) : null;
  } catch { return null; }
}

export async function preflight(cwd: string, opts: { base?: string; range?: string; run?: Kind[]; timeoutS?: number } = {}): Promise<Preflight | string> {
  const c = await classifyRepo(cwd, { base: opts.base, range: opts.range });
  if (typeof c === "string") return c;
  const top = (await git(["rev-parse", "--show-toplevel"], cwd))?.trim() ?? cwd;

  // Quality commands: skip when nothing but docs/generated files changed.
  const kinds = opts.run ?? configuredKinds(top) ?? (["lint", "typecheck", "test"] as Kind[]);
  const found = detect(top);
  const codeChanged = c.changed.some((f) => !/\.(md|mdx|rst|txt|adoc)$/i.test(f));
  const quality = [];
  if (codeChanged) {
    for (const cmd of found.commands.filter((x) => kinds.includes(x.kind))) {
      quality.push(await runCommand(cmd, top, opts.timeoutS ?? 300, 15));
    }
  }
  const notDetected = kinds.filter((k) => !found.commands.some((x) => x.kind === k));

  // Secrets in added lines only.
  const patch = (await git(["diff", "-U0", "--no-color", "--no-ext-diff", ...c.diffArgs], top)) ?? "";
  let secrets = scanPatch(patch);
  if (c.target.mode !== "range") {
    const untracked = ((await git(["ls-files", "--others", "--exclude-standard"], top)) ?? "").split("\n").filter(Boolean);
    const { scanText } = await import("./scan_secrets");
    for (const f of untracked) {
      try { const t = readFileSync(join(top, f), "utf8"); if (!t.includes("\u0000")) secrets.push(...scanText(t, f)); } catch { /* unreadable */ }
    }
  }

  // CI audit when workflow files changed (the auditor ships with the ci-cd-pipeline skill).
  let ci: Preflight["ci"] = [];
  const changedWorkflows = c.gates.infra.signals.map((s) => s.file).filter((f) => /\.github\/workflows\/.+\.ya?ml$/.test(f));
  const auditor = join(dirname(import.meta.path), "..", "..", "ci-cd-pipeline", "scripts", "audit_ci.ts");
  if (changedWorkflows.length && existsSync(auditor)) {
    const { auditWorkflow } = await import(auditor);
    for (const f of changedWorkflows) {
      try { ci.push(...auditWorkflow(Bun.YAML.parse(readFileSync(join(top, f), "utf8")), f).findings); } catch { /* unparsable: reported by the review */ }
    }
  }

  const reviews: Review[] = [];
  for (const [gate, skill] of Object.entries(REVIEW_SKILL)) {
    const g = (c.gates as Record<string, { level: string; signals: { signal: string; file: string; line?: number }[] }>)[gate];
    if (g.level === "required") {
      // Security asks for a review only on risky code (a content pattern) or a path the project marked;
      // a file merely living under auth/ or a dependency bump is a note, not a block.
      const weak = new Set(["security-sensitive path", "supply-chain: dependency change", "pipeline or infra permissions surface"]);
      const strongSignals = gate === "security" ? g.signals.filter((s) => !weak.has(s.signal)) : g.signals;
      const shown = strongSignals.length ? strongSignals : g.signals;
      const why = shown.slice(0, 2).map((s) => `${s.signal}${s.file ? ` (${s.file}${s.line ? `:${s.line}` : ""})` : ""}`).join("; ");
      reviews.push({ gate, skill, why, strong: strongSignals.length > 0 });
    }
  }
  const advisories: string[] = [];
  if (c.gates.tests.level === "required") advisories.push(`source changed with no test change: ${c.gates.tests.signals.slice(0, 3).map((s) => s.file).join(", ")}`);
  if (c.gates.docs.level !== "skip") advisories.push("public surface changed with no docs change");
  for (const q of quality.filter((x) => x.no_tests)) advisories.push(`\`${q.command}\` found no test files; nothing was tested`);

  const blocking = [
    ...quality.filter((q) => !q.passed).map((q) => `${q.kind} failed: \`${q.command}\` exit ${q.exit_code}${q.timed_out ? " (timed out)" : ""}`),
    ...secrets.filter((s) => s.confidence === "high").map((s) => `secret (${s.rule}) at ${s.file}:${s.line}, value ${s.masked}`),
    ...ci.filter((f) => f.level === "high").map((f) => `CI ${f.id} in ${f.file}${f.job ? ` job ${f.job}` : ""}: ${f.message}`),
  ];
  return {
    ok: blocking.length === 0, target: c.target, size: c.size, totals: c.totals,
    quality: quality.map(({ kind, command, passed, exit_code, timed_out, no_tests, duration_s, output_tail }) => ({ kind, command, passed, exit_code, timed_out, no_tests, duration_s, output_tail })),
    not_detected: notDetected, secrets, ci, reviews, advisories, blocking,
  };
}

export function render(p: Preflight): string {
  const t = p.totals;
  const lines = [`preflight: ${p.ok ? "PASS" : `FAIL (${p.blocking.length} blocking)`} · size ${p.size} · ${t.reviewed_files} file(s) +${t.added}/-${t.deleted}`];
  for (const q of p.quality) lines.push(`${q.no_tests ? "·" : q.passed ? "✓" : "✗"} ${q.kind.padEnd(9)} ${q.command} — ${q.no_tests ? "no test files" : `exit ${q.exit_code}`}, ${q.duration_s}s`);
  if (!p.quality.length) lines.push("· quality  not run (no code change)");
  if (p.not_detected.length) lines.push(`· not detected: ${p.not_detected.join(", ")}`);
  lines.push(p.secrets.length ? `✗ secrets  ${p.secrets.length} finding(s): ${p.secrets.slice(0, 3).map((s) => `${s.rule} ${s.file}:${s.line} ${s.masked}`).join("; ")}` : "✓ secrets  none in the diff");
  if (p.ci.length) lines.push(`! ci       ${p.ci.length} finding(s), ${p.ci.filter((f) => f.level === "high").length} high`);
  for (const r of p.reviews) lines.push(`${r.strong ? "!" : "·"} review   ${r.gate} → ${r.skill}${r.strong ? "" : " (optional)"}: ${r.why}`);
  for (const a of p.advisories) lines.push(`· note     ${a}`);
  for (const q of p.quality.filter((x) => !x.passed)) lines.push(`--- ${q.kind} output (tail) ---`, q.output_tail.split("\n").slice(-12).join("\n"));
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      help: { type: "boolean", short: "h" }, C: { type: "string", short: "C" }, base: { type: "string" }, range: { type: "string" },
      run: { type: "string" }, timeout: { type: "string" }, json: { type: "boolean" } } }));
  } catch (e) { console.error((e as Error).message); return 2; }
  if (values.help) { console.log("usage: preflight.ts [-C PATH] [--base BRANCH | --range RANGE] [--run KINDS|none] [--timeout S] [--json]"); return 0; }
  const run = values.run === undefined ? undefined : values.run === "none" ? [] : (values.run.split(",").map((s) => s.trim()) as Kind[]);
  if (run?.some((k) => !(KINDS as readonly string[]).includes(k))) { console.error(`--run takes ${KINDS.join(",")} or none`); return 2; }
  const p = await preflight(values.C ?? process.cwd(), { base: values.base, range: values.range, run, timeoutS: values.timeout ? Number(values.timeout) : undefined });
  if (typeof p === "string") { console.log(values.json ? JSON.stringify({ error: p }) : `preflight: error: ${p}`); return 2; }
  console.log(values.json ? JSON.stringify(p, null, 2) : render(p));
  return p.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
