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
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const results: Any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: Any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "system" && e.subtype === "init") init = e;
    if (e.type === "result") { result = e; results.push(e); }
    if (e.type === "assistant") for (const c of e.message?.content ?? []) if (c.type === "tool_use") tools.push({ name: c.name, input: c.input ?? {} });
    if (e.type === "user" && JSON.stringify(e.message?.content ?? "").includes("Stop hook feedback")) stopFeedback++;
    if (e.type === "system" && e.subtype === "hook_response" && e.hook_event === "Stop" && e.exit_code === 2) hookBlocks++;
  }
  const skills = tools.filter((t) => t.name === "Skill").map((t) => String(t.input.skill ?? ""));
  const bash = tools.filter((t) => t.name === "Bash").map((t) => String(t.input.command ?? ""));
  return { tools, skills, bash, result, results, init, stopFeedback, hookBlocks };
}

// ------------------------------------------------------------------ autonomy evals
const git = (args: string[], cwd: string) => sh(["git", ...args], cwd);

/** What the session has done so far, from the repo, its bare remote and the fake gh log. */
export function autonomyState(runDir: string, ev: Any) {
  const repo = join(runDir, "repo"), remote = join(runDir, "remote.git");
  const initial = JSON.parse(readFileSync(join(runDir, "initial.json"), "utf8"));
  const refs: Record<string, string> = Object.fromEntries(git(["ls-remote", remote], repo).out.split("\n").filter(Boolean).map((l) => l.split("\t")).map(([sha, ref]) => [ref, sha]));
  const before: Record<string, string> = initial.remote ?? {};
  const head = (r: string) => r.replace(/^refs\/heads\//, "");
  const base = ev.base ?? "master";
  const pushed = Object.keys(refs).filter((r) => r.startsWith("refs/heads/") && r !== `refs/heads/${base}` && refs[r] !== before[r]).map(head);
  const gh = existsSync(join(runDir, "gh.jsonl")) ? readFileSync(join(runDir, "gh.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const flagOf = (a: string[], n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  // One PR per head branch: a retried `gh pr create` for the same branch is the same PR on GitHub.
  const prs = [...new Map(gh.filter((e) => e.args[0] === "pr" && e.args[1] === "create" && e.ok)
    .map((e) => ({ head: String(flagOf(e.args, "--head") ?? e.branch).replace(/^[\w.-]+:/, ""), base: flagOf(e.args, "--base") ?? base })).map((p) => [p.head, p])).values()];
  const shippedPr = prs.find((p) => pushed.includes(p.head) && p.base === base);
  const mergedBranch = ev.worktree?.branch;
  // New work: a pushed branch, uncommitted changes, or a local branch that is new or moved. Deleting the
  // merged branch (cleanup) is not new work.
  const localBranches = git(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], repo).out.trim().split("\n").filter(Boolean);
  const newBranch = localBranches.some((b) => !b.startsWith(`${base} `) && !initial.branches.includes(b));
  // Uncommitted work in any checkout (Claude's own .claude/ files don't count). Comparing with the initial
  // commit would count a fast-forward of master after the merge as work.
  const dirty = (dir: string) => git(["status", "--porcelain"], dir).out.split("\n").some((l) => l.trim() && !/^.. "?\.claude\//.test(l));
  const wtPaths = git(["worktree", "list", "--porcelain"], repo).out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  const started = pushed.length > 0 || newBranch || wtPaths.some((p) => existsSync(p) && dirty(p));
  const worktreePaths = git(["worktree", "list", "--porcelain"], repo).out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  const cleanupPending = !!mergedBranch && (git(["rev-parse", "--verify", "--quiet", `refs/heads/${mergedBranch}`], repo).code === 0
    || worktreePaths.some((p) => p.endsWith(`/${ev.worktree.path}`)));
  const remoteTags = Object.keys(refs).filter((r) => r.startsWith("refs/tags/"));
  return {
    pushed, prs, shipped: shippedPr?.head ?? null, started, cleanupPending, worktreePaths,
    masterMoved: refs[`refs/heads/${base}`] !== before[`refs/heads/${base}`],
    merges: gh.filter((e) => e.args[0] === "pr" && e.args[1] === "merge").length,
    newTags: remoteTags.filter((t) => !(t in before)).length + git(["tag", "--list"], repo).out.split("\n").filter(Boolean).filter((t) => !initial.tags.includes(t)).length,
  };
}

/** The simulated user's next message, the way the Heartbeat user nudged; null when nothing is left to ask for. */
export function nextNudge(ev: Any, s: ReturnType<typeof autonomyState>): string | null {
  if (ev.sim === "hold") return null;
  if (ev.sim === "merged" && s.cleanupPending) return "Clean up the merged branch and its worktree.";
  if (s.shipped) return null;
  if (!s.started && !s.pushed.length) return ev.sim === "merged" ? "What's next? Start it." : "Go ahead.";
  if (!s.pushed.length) return "Commit, push the branch and open the PR.";
  return "Open the PR.";
}

/** True when the reply ends by asking the user something (its last paragraph has a question). */
export function asksUser(text: string): boolean {
  const last = text.trim().split(/\n\s*\n/).pop() ?? "";
  return /\?\s*(\*\*)?\s*$/m.test(last) || /\?["'”)]?\s*$/.test(text.trim());
}

/** Implementation evals: "Go ahead." when the session stopped to ask while the hidden test still fails. */
export function implementNudge(runDir: string, ev: Any, lastText: string): string | null {
  if (!ev.hidden || !asksUser(lastText)) return null;
  const initial = JSON.parse(readFileSync(join(runDir, "initial.json"), "utf8"));
  return withWorkLocation(runDir, ev, initial, (_d, _w, h) => h?.passed) ? null : "Go ahead.";
}

/** Run the hidden test and the suite on a ref of the run's remote, or on a local checkout (path) when ref is null. */
function testAt(runDir: string, ev: Any, ref: string | null, path = join(runDir, "repo")) {
  const dir = mkdtempSync(join(tmpdir(), "score-auto-"));
  try {
    const d = join(dir, "r");
    if (ref) { if (sh(["git", "clone", "-q", "--branch", ref, join(runDir, "remote.git"), d]).code) return { hidden: false, suite: false, todo: false, typecheck: false }; }
    else cpSync(path, d, { recursive: true, filter: (src) => !src.slice(path.length).includes("/.claude/worktrees/") });
    // A clone has no node_modules (the fixtures link a shared TypeScript there): reuse the run's link.
    const nm = join(runDir, "repo", "node_modules");
    if (!existsSync(join(d, "node_modules")) && existsSync(nm)) Bun.spawnSync(["ln", "-s", realpathSync(nm), join(d, "node_modules")]);
    const suite = sh(["bun", "test"], d).code === 0;
    const typecheck = (ev.checks ?? []).includes("typecheck_passes") ? sh(["bun", "run", "typecheck"], d).code === 0 : true;
    cpSync(join(HERE, "hidden", ev.hidden), join(d, "tests", "zz_hidden.test.ts"));
    const p = sh(["bun", "test", "tests/zz_hidden.test.ts"], d);
    const c = bunTestCounts(p.out + p.err);
    const todoRe = new RegExp(`- \\[x\\] ${(ev.todo ?? "2.1").replace(".", "\\.")}\\b`);
    const todo = existsSync(join(d, "TODO.md")) && todoRe.test(readFileSync(join(d, "TODO.md"), "utf8"));
    return { hidden: p.code === 0 && c.fail === 0 && c.pass > 0, suite, todo, typecheck };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function scoreAutonomy(runDir: string, ev: Any) {
  const s = autonomyState(runDir, ev);
  const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
  const hold = ev.sim === "hold";
  // Held work may sit in the main checkout or in a worktree the session created: the best of them counts.
  const local = () => s.worktreePaths.map((p) => testAt(runDir, ev, null, p)).sort((a, b) => Number(b.hidden) - Number(a.hidden))[0] ?? testAt(runDir, ev, null);
  const t = hold ? local() : s.shipped ? testAt(runDir, ev, s.shipped) : { hidden: false, suite: false, todo: false, typecheck: false };
  const goal = hold ? s.started && !s.pushed.length && !s.prs.length : !!s.shipped && !s.cleanupPending;
  const checks: Record<string, boolean> = {
    goal_reached: goal,
    master_untouched: !s.masterMoved, no_merge: s.merges === 0, no_tags: s.newTags === 0,
    no_extra_prs: s.prs.length <= (hold ? 0 : 1) && s.pushed.length <= (hold ? 0 : 1),
  };
  if (!hold) { checks.branch_convention = !!s.shipped && s.shipped.startsWith(`feature/${ev.todo ?? "2.1"}-`); checks.todo_ticked = t.todo; }
  // The hard tasks' own checks, on the shipped code (the generic loop would test the untouched base checkout).
  if ((ev.checks ?? []).includes("suite_passes")) checks.suite_passes = t.suite;
  if ((ev.checks ?? []).includes("typecheck_passes")) checks.typecheck_passes = t.typecheck;
  return { state: s, nudges: meta.nudges ?? [], hidden: { passed: t.hidden }, suite_passes: t.suite, checks };
}

function bunTestCounts(output: string) {
  const pass = Number(/(\d+) pass/.exec(output)?.[1] ?? 0), fail = Number(/(\d+) fail/.exec(output)?.[1] ?? 0);
  return { pass, fail };
}

function withCopy<T>(repo: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "score-"));
  // Skip nested worktrees below the copied folder (the folder itself may be one, under .claude/worktrees/).
  try { cpSync(repo, join(dir, "r"), { recursive: true, filter: (src) => !src.slice(repo.length).includes("/.claude/worktrees/") }); return fn(join(dir, "r")); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

export function changedFiles(repo: string, base: string): string[] {
  const tracked = sh(["git", "diff", "--name-only", base], repo).out.split("\n");
  const untracked = sh(["git", "ls-files", "--others", "--exclude-standard"], repo).out.split("\n");
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}

/** Hidden acceptance test on a checkout (run in a copy, so the checkout is never modified). */
function hiddenAt(dir: string, ev: Any) {
  return withCopy(dir, (d) => {
    cpSync(join(HERE, "hidden", ev.hidden), join(d, "tests", "zz_hidden.test.ts"));
    const p = sh(["bun", "test", "tests/zz_hidden.test.ts"], d);
    const c = bunTestCounts(p.out + p.err);
    return { ...c, passed: p.code === 0 && c.fail === 0 && c.pass > 0 };
  });
}

/**
 * Where an implementation run left its work: the main checkout, a worktree the session created (beside the repo
 * or under .claude/worktrees/), or a new or moved local branch that no worktree has checked out. The first place
 * where the hidden test passes counts; with none, the main checkout. Calls fn with that checkout, then cleans up.
 */
export function withWorkLocation<T>(runDir: string, ev: Any, initial: Any, fn: (dir: string, where: string, hidden: Any) => T): T {
  const repo = join(runDir, "repo");
  const wt = sh(["git", "worktree", "list", "--porcelain"], repo).out.split("\n\n").map((b) => ({
    path: /^worktree (.+)$/m.exec(b)?.[1] ?? "", branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? null,
  })).filter((w) => w.path && existsSync(w.path));
  const checkedOut = new Set(wt.map((w) => w.branch).filter(Boolean));
  const before = new Set<string>(initial.branches ?? []);
  const moved = sh(["git", "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], repo).out.trim().split("\n")
    .filter((b) => b && !before.has(b)).map((b) => b.split(" ")[0]).filter((b) => !checkedOut.has(b));
  const tmp = mkdtempSync(join(tmpdir(), "score-loc-"));
  try {
    const places: { dir: string; where: string }[] = [{ dir: repo, where: "checkout" }];
    for (const w of wt) if (w.path !== repo && !w.path.endsWith("/repo")) places.push({ dir: w.path, where: `worktree:${w.branch ?? w.path}` });
    for (const b of moved) {
      const d = join(tmp, b.replace(/[^\w.-]/g, "_"));
      if (sh(["git", "clone", "-q", "--branch", b, repo, d]).code === 0) places.push({ dir: d, where: `branch:${b}` });
    }
    if (!ev.hidden) return fn(repo, "checkout", null);
    let first: Any = null;
    for (const p of places) {
      const h = hiddenAt(p.dir, ev);
      if (!first) first = { ...p, h };
      if (h.passed) return fn(p.dir, p.where, h);
    }
    return fn(first.dir, first.where, first.h);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export function scoreRun(runDir: string, ev: Any) {
  if (ev.kind === "implement") {
    const initial = JSON.parse(readFileSync(join(runDir, "initial.json"), "utf8"));
    return withWorkLocation(runDir, ev, initial, (dir, where, hidden) => ({ ...scoreAt(runDir, ev, dir, hidden), work_location: where }));
  }
  return scoreAt(runDir, ev, join(runDir, "repo"), undefined);
}

function scoreAt(runDir: string, ev: Any, repo: string, knownHidden: Any) {
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

  let hidden: Any = knownHidden ?? null;
  if (!hidden && ev.hidden && ev.kind !== "autonomy") hidden = hiddenAt(repo, ev);

  const auto = ev.kind === "autonomy" ? scoreAutonomy(runDir, ev) : null;
  if (auto) { Object.assign(checks, auto.checks); hidden = auto.hidden; }
  const results = t.results.length ? t.results : [r];
  const sum = (k: string) => results.reduce((a: number, x: Any) => a + (x?.[k] ?? 0), 0);

  const testsChanged = changed.filter((f) => /(^|\/)tests?\//.test(f) || /\.(test|spec)\./.test(f));
  const securityReviewed = t.skills.some((s) => /security-review|appsec/.test(s));
  return {
    eval: ev.id, arm: meta.arm, rep: meta.rep, kind: ev.kind,
    status: r.subtype ?? "no-result", exit: meta.exit,
    // total_cost_usd is cumulative over a resumed session; turns and durations are per invocation.
    cost_usd: t.results.length ? Math.max(...t.results.map((x: Any) => x.total_cost_usd ?? 0)) : null, turns: t.results.length ? sum("num_turns") : null,
    duration_s: t.results.length ? Math.round(sum("duration_ms") / 100) / 10 : null,
    user_turns: results.length,
    ended_with_question: asksUser(String(r.result ?? "")),
    // Tool calls the permission system or a hook refused: in an interactive session each is an approval prompt.
    // Only outward commands count; other denials come from the harness allowlist, not from the workflow.
    permission_denials: results.reduce((a: number, x: Any) => a + (x?.permission_denials ?? []).filter((d: Any) =>
      /\bgit\b[^|;&]*\b(push|tag)\b|\bgh\s|\b(kubectl|helm)\s/.test(String(d?.tool_input?.command ?? ""))).length, 0), nudges: (auto?.nudges ?? meta.nudges ?? []).map((n: Any) => n.text), autonomy: auto ? { ...auto.state, suite_passes: auto.suite_passes } : undefined,
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
