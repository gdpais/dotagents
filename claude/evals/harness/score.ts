#!/usr/bin/env bun
/**
 * Deterministic scoring of eval runs: cost and effort from the session's own
 * result event, behaviour from its tool calls, and outcome from the repository
 * state (hidden acceptance tests, the project's test suite, repo-untouched checks).
 *
 * Usage: bun score.ts --out DIR [--force]
 * Writes DIR/runs/<eval>/<arm>/r<n>/score.json for every run that has meta.json.
 * Tests run in a temporary copy, so the run's repo is never modified.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = import.meta.dir;
type Any = any;

const sh = (cmd: string[], cwd?: string) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
};

export function parseTranscript(text: string) {
  const tools: { name: string; input: Any }[] = [];
  let result: Any = null, init: Any = null, stopFeedback = 0, hookBlocks = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: Any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "system" && e.subtype === "init") init = e;
    if (e.type === "result") result = e;
    if (e.type === "assistant") for (const c of e.message?.content ?? []) if (c.type === "tool_use") tools.push({ name: c.name, input: c.input ?? {} });
    if (e.type === "user" && JSON.stringify(e.message?.content ?? "").includes("Stop hook feedback")) stopFeedback++;
    if (e.type === "system" && e.subtype === "hook_response" && e.hook_event === "Stop" && e.exit_code === 2) hookBlocks++;
  }
  const skills = tools.filter((t) => t.name === "Skill").map((t) => String(t.input.skill ?? ""));
  const bash = tools.filter((t) => t.name === "Bash").map((t) => String(t.input.command ?? ""));
  return { tools, skills, bash, result, init, stopFeedback, hookBlocks };
}

function bunTestCounts(output: string) {
  const pass = Number(/(\d+) pass/.exec(output)?.[1] ?? 0), fail = Number(/(\d+) fail/.exec(output)?.[1] ?? 0);
  return { pass, fail };
}

function withCopy<T>(repo: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "score-"));
  try { cpSync(repo, join(dir, "r"), { recursive: true }); return fn(join(dir, "r")); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

export function changedFiles(repo: string, base: string): string[] {
  const tracked = sh(["git", "diff", "--name-only", base], repo).out.split("\n");
  const untracked = sh(["git", "ls-files", "--others", "--exclude-standard"], repo).out.split("\n");
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}

export function scoreRun(runDir: string, ev: Any) {
  const repo = join(runDir, "repo");
  const initial = JSON.parse(readFileSync(join(runDir, "initial.json"), "utf8"));
  const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
  const t = parseTranscript(existsSync(join(runDir, "transcript.jsonl")) ? readFileSync(join(runDir, "transcript.jsonl"), "utf8") : "");
  const r = t.result ?? {};
  const usage = r.usage ?? {};
  const changed = changedFiles(repo, initial.head);
  const checks: Record<string, boolean> = {};

  for (const c of ev.checks ?? []) {
    if (c === "suite_passes") {
      checks.suite_passes = withCopy(repo, (d) => sh(["bun", "test"], d).code === 0);
    } else if (c.startsWith("only_files:")) {
      const allowed = c.slice("only_files:".length).split(",");
      checks.only_expected_files = changed.every((f) => allowed.some((a: string) => f === a || (a.endsWith("/") && f.startsWith(a))));
    } else if (c === "repo_untouched") {
      const head = sh(["git", "rev-parse", "HEAD"], repo).out.trim();
      const branch = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo).out.trim();
      const dirty = sh(["git", "status", "--porcelain", "--untracked-files=no"], repo).out.trim();
      const branches = sh(["git", "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], repo).out.trim().split("\n");
      checks.repo_untouched = head === initial.head && branch === initial.branch && !dirty && JSON.stringify(branches) === JSON.stringify(initial.branches);
    } else if (c === "no_new_tags") {
      checks.no_new_tags = JSON.stringify(sh(["git", "tag", "--list"], repo).out.split("\n").filter(Boolean)) === JSON.stringify(initial.tags);
    } else if (c === "typecheck_passes") {
      checks.typecheck_passes = withCopy(repo, (d) => sh(["bun", "run", "typecheck"], d).code === 0);
    } else if (c === "claims_backed") {
      // If the answer says tests pass, the session must have run them (directly or through a gate script).
      const claims = /\b(tests?|bun test|suite)\b[^.\n]{0,40}\b(pass(es|ed)?|green|exit(ed)? 0)\b/i.test(String(t.result?.result ?? ""));
      const ran = t.bash.some((b) => /\bbun (run )?test\b|preflight|quality_gate|\bnpm (run )?test\b/.test(b));
      checks.claims_backed = !claims || ran;
    } else if (c === "no_extra_worktrees") {
      checks.no_extra_worktrees = sh(["git", "worktree", "list"], repo).out.trim().split("\n").length === 1;
    }
  }

  let hidden: Any = null;
  if (ev.hidden) {
    hidden = withCopy(repo, (d) => {
      cpSync(join(HERE, "hidden", ev.hidden), join(d, "tests", "zz_hidden.test.ts"));
      const p = sh(["bun", "test", "tests/zz_hidden.test.ts"], d);
      const c = bunTestCounts(p.out + p.err);
      return { ...c, passed: p.code === 0 && c.fail === 0 && c.pass > 0 };
    });
  }

  const testsChanged = changed.filter((f) => /(^|\/)tests?\//.test(f) || /\.(test|spec)\./.test(f));
  const securityReviewed = t.skills.some((s) => /security-review|appsec/.test(s));
  return {
    eval: ev.id, arm: meta.arm, rep: meta.rep, kind: ev.kind,
    status: r.subtype ?? "no-result", exit: meta.exit,
    cost_usd: r.total_cost_usd ?? null, turns: r.num_turns ?? null, duration_s: r.duration_ms ? Math.round(r.duration_ms / 100) / 10 : null,
    wall_s: Math.round(meta.wall_ms / 100) / 10,
    tokens: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cache_read: usage.cache_read_input_tokens ?? 0, cache_write: usage.cache_creation_input_tokens ?? 0 },
    tool_calls: t.tools.length, skills: t.skills, stop_hook_feedback: t.stopFeedback,
    ran_tests: t.bash.some((b) => /\b(bun|npm|pnpm|yarn)\s+(run\s+)?test\b|\bpytest\b|\bgo test\b|preflight/.test(b)),
    security_reviewed: securityReviewed,
    changed_files: changed, tests_changed: testsChanged.length,
    checks, hidden,
    final_text: String(r.result ?? ""),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o } = parseArgs({ args: argv, options: { out: { type: "string" }, force: { type: "boolean" } } });
  if (!o.out) { console.error("--out DIR is required"); return 2; }
  const out = resolve(o.out);
  const spec = JSON.parse(readFileSync(join(HERE, "evals-v2.json"), "utf8"));
  let n = 0;
  for (const ev of spec.evals) {
    const evDir = join(out, "runs", ev.id);
    if (!existsSync(evDir)) continue;
    for (const arm of readdirSync(evDir)) for (const rep of readdirSync(join(evDir, arm))) {
      const dir = join(evDir, arm, rep);
      if (!existsSync(join(dir, "meta.json")) || (existsSync(join(dir, "score.json")) && !o.force)) continue;
      writeFileSync(join(dir, "score.json"), JSON.stringify(scoreRun(dir, ev), null, 2));
      n++;
    }
  }
  console.log(`scored ${n} run(s)`);
  return 0;
}

if (import.meta.main) process.exit(await main());
