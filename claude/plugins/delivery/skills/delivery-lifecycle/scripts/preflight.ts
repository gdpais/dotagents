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
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { classifyRepo, memoGit, type Classified, type Git } from "./classify_change";
import { detect, KINDS, runCommand, type Kind } from "./quality_gate";
import { scanPatch, type Finding } from "./scan_secrets";

export interface Review { gate: string; skill: string; why: string; strong: boolean }
export type QualityResult = Awaited<ReturnType<typeof runCommand>>;
/** Quality results by key (`treeKey`, kind, timeout, command), so a check of files already checked reuses them. */
export interface QualityCache { get(key: string): QualityResult | undefined; set(key: string, result: QualityResult): void }
export interface Preflight {
  ok: boolean;
  target: Record<string, string>;
  size: string;
  totals: Classified["totals"];
  changed: string[];
  quality: { kind: string; command: string; passed: boolean; exit_code: number; timed_out: boolean; no_tests: boolean; duration_s: number; output_tail: string; cached?: boolean }[];
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

/**
 * A key for the files the quality commands see: each tracked and untracked (not ignored) file's blob id, with the
 * work tree's edits applied. The same files give the same key whatever HEAD is, so committing checked work keeps its
 * results. Null when git can't say (then nothing is cached).
 */
export async function treeKey(top: string, g: Git = git as Git): Promise<string | null> {
  const [index, changed, untracked] = await Promise.all([
    g(["ls-files", "-s", "-z"], top), g(["diff", "--name-only", "-z"], top), g(["ls-files", "--others", "--exclude-standard", "-z"], top),
  ]);
  if (index === null || changed === null || untracked === null) return null;
  const files = new Map<string, string>();
  for (const e of index.split("\0")) {
    const m = /^\d+ ([0-9a-f]+) (\d)\t([^]*)$/.exec(e);
    if (m) files.set(m[2] === "0" ? m[3] : `${m[3]}\0${m[2]}`, m[1]);
  }
  const edited = [...new Set([...changed.split("\0"), ...untracked.split("\0")].filter(Boolean))];
  const present = edited.filter((f) => { try { return statSync(join(top, f)).isFile(); } catch { return false; } });
  for (const f of edited) if (!present.includes(f)) files.delete(f);
  if (present.length) {
    try {
      const p = Bun.spawn(["git", "hash-object", "--stdin-paths"], { cwd: top, stdin: new Blob([present.join("\n") + "\n"]), stdout: "pipe", stderr: "ignore" });
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      const ids = out.trim().split("\n");
      if (code !== 0 || ids.length !== present.length) return null;
      present.forEach((f, i) => files.set(f, ids[i]));
    } catch { return null; }
  }
  return Bun.hash([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([f, id]) => `${id} ${f}`).join("\0")).toString(36);
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

/**
 * `git`: a shared runner (memoGit) so a caller that already asked git for the toplevel or refs isn't asked again.
 * `cache`: reuse quality results for the same files (`treeKey`); results that timed out aren't stored.
 */
export async function preflight(cwd: string, opts: { base?: string; range?: string; run?: Kind[]; timeoutS?: number; git?: Git; cache?: QualityCache } = {}): Promise<Preflight | string> {
  const g = opts.git ?? memoGit();
  const c = await classifyRepo(cwd, { base: opts.base, range: opts.range }, undefined, { git: g });
  if (typeof c === "string") return c;
  const top = (await g(["rev-parse", "--show-toplevel"], cwd))?.trim() ?? cwd;

  // Quality commands: skip when nothing but docs/generated files changed.
  const kinds = opts.run ?? configuredKinds(top) ?? (["lint", "typecheck", "test"] as Kind[]);
  const found = detect(top);
  const codeChanged = c.changed.some((f) => !/\.(md|mdx|rst|txt|adoc)$/i.test(f));
  const quality: (QualityResult & { cached?: boolean })[] = [];
  const toRun = codeChanged ? found.commands.filter((x) => kinds.includes(x.kind)) : [];
  // Keyed before any command runs: a formatter may rewrite files, and its result belongs to the files it was given.
  const tree = opts.cache && toRun.length ? await treeKey(top, g) : null;
  const timeoutS = opts.timeoutS ?? 300;
  for (const cmd of toRun) {
    const key = tree ? [tree, cmd.kind, timeoutS, cmd.command].join("\0") : null;
    const hit = key ? opts.cache!.get(key) : undefined;
    if (hit) { quality.push({ ...hit, cached: true }); continue; }
    const r = await runCommand(cmd, top, timeoutS, 15);
    if (key && !r.timed_out) opts.cache!.set(key, r);
    quality.push(r);
  }
  const notDetected = kinds.filter((k) => !found.commands.some((x) => x.kind === k));

  // Secrets in added lines only.
  // The untracked list classify read is still current unless a quality command ran since (it may write files);
  // a cached result ran nothing.
  const [patchOut, untrackedOut] = await Promise.all([
    git(["diff", "-U0", "--no-color", "--no-ext-diff", ...c.diffArgs], top),
    c.target.mode !== "range" ? (quality.some((q) => !q.cached) ? git : g)(["ls-files", "--others", "--exclude-standard"], top) : null,
  ]);
  const patch = patchOut ?? "";
  let secrets = scanPatch(patch);
  if (c.target.mode !== "range") {
    const untracked = (untrackedOut ?? "").split("\n").filter(Boolean);
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
    ...quality.filter((q) => !q.passed).map((q) => `${q.kind} failed: \`${q.command}\` exit ${q.exit_code}${q.timed_out ? " (timed out)" : ""}${q.cached ? " (result from an earlier check of the same files)" : ""}`),
    ...secrets.filter((s) => s.confidence === "high").map((s) => `secret (${s.rule}) at ${s.file}:${s.line}, value ${s.masked}`),
    ...ci.filter((f) => f.level === "high").map((f) => `CI ${f.id} in ${f.file}${f.job ? ` job ${f.job}` : ""}: ${f.message}`),
  ];
  return {
    ok: blocking.length === 0, target: c.target, size: c.size, totals: c.totals, changed: c.changed,
    quality: quality.map(({ kind, command, passed, exit_code, timed_out, no_tests, duration_s, output_tail, cached }) => ({ kind, command, passed, exit_code, timed_out, no_tests, duration_s, output_tail, ...(cached ? { cached } : {}) })),
    not_detected: notDetected, secrets, ci, reviews, advisories, blocking,
  };
}

export function render(p: Preflight): string {
  const t = p.totals;
  const lines = [`preflight: ${p.ok ? "PASS" : `FAIL (${p.blocking.length} blocking)`} · size ${p.size} · ${t.reviewed_files} file(s) +${t.added}/-${t.deleted}`];
  for (const q of p.quality) lines.push(`${q.no_tests ? "·" : q.passed ? "✓" : "✗"} ${q.kind.padEnd(9)} ${q.command} — ${q.no_tests ? "no test files" : `exit ${q.exit_code}`}, ${q.duration_s}s${q.cached ? " (cached: same files as an earlier check)" : ""}`);
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
