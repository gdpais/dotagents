#!/usr/bin/env bun
/**
 * Run delivery evals as real, headless Claude Code sessions (`claude -p`), one fresh
 * session per (eval, arm, repetition), each in its own copy of the fixture repo.
 *
 * Usage:
 *   bun run.ts --out DIR [--arms vanilla,v1,v2] [--reps 3] [--evals id,...]
 *              [--concurrency 6] [--budget 5] [--model MODEL] [--v1-skills DIR]
 *
 * Arms:
 *   vanilla  the user's normal setup, nothing added
 *   v1       --v1-skills copied into the repo as project skills (.claude/skills)
 *   v2, v2.x, v3 the delivery plugin in its current state (arm v2.3 uses --prev-plugin DIR when given), loaded with --plugin-dir (skills + hooks);
 *            on autonomy evals the repo also gets the spec's `.claude/delivery.json` policy
 *   ondemand nothing installed; uses the eval's `ondemand_prompt`, which names the skill file or script
 *   claudemd nothing installed; the spec's working agreement in .claude/CLAUDE.md (autonomy evals' control)
 *   <arm>+app the same arm with the spec's `autonomy.app_prompt` appended to the system prompt: the
 *            Claude desktop app's rules about pushing and confirming outward actions, which `claude -p` lacks
 *
 * Autonomy evals (kind "autonomy") run several turns: the repo gets a local bare remote and a fake `gh`
 * (shims/gh, logging to gh.jsonl), and after each turn a simulated user sends the next nudge a real user
 * would ("Push the branch and open the PR.") until the goal is reached or `max_nudges` runs out.
 *
 * Fixtures come from make_fixtures.sh (built into DIR/fixtures when missing).
 * Each run writes DIR/runs/<eval>/<arm>/r<n>/{repo/, transcript.jsonl, stderr.txt,
 * initial.json, meta.json}. Finished runs are skipped, so the command resumes.
 * Prompts are passed verbatim: nothing tells the agent which skills exist.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { autonomyState, implementNudge, nextNudge } from "./score";

const HERE = import.meta.dir;
const PLUGIN = resolve(HERE, "..", "..", "plugins", "delivery");

export const ALLOWED = [
  "Read", "Edit", "Write", "Glob", "Grep", "Skill", "Agent", "Task", "TodoWrite", "NotebookEdit",
  ...["git", "bun", "bunx", "node", "npm", "npx", "ls", "cat", "grep", "rg", "find", "sed", "awk", "head", "tail", "wc", "diff",
    "od", "mkdir", "cp", "mv", "echo", "printf", "cd", "pwd", "which", "sort", "uniq", "jq", "python3", "test", "true", "tree",
    "xargs", "time", "hyperfine", "du", "touch", "basename", "dirname", "realpath", "tee", "date", "sleep"].map((c) => `Bash(${c} *)`),
];
export const DENIED = ["Bash(git push *)", "Bash(gh *)", "Bash(curl *)", "Bash(wget *)", "WebFetch", "WebSearch"];

const sh = (cmd: string[], cwd?: string) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};

type Any = any;
interface Job { eval: Any; arm: string; rep: number; dir: string }
export const isPlugin = (arm: string) => /^v\d/.test(arm);
export const baseArm = (arm: string) => arm.split("+")[0];

/** Remote heads and tags as {ref: sha}. */
export function remoteRefs(remote: string): Record<string, string> {
  const r = sh(["git", "ls-remote", remote]);
  return Object.fromEntries(r.out.split("\n").filter(Boolean).map((l) => l.split("\t")).map(([sha, ref]) => [ref, sha]));
}

function prepare(job: Job, out: string, v1Skills: string, spec: Any) {
  const repo = join(job.dir, "repo");
  mkdirSync(job.dir, { recursive: true });
  cpSync(join(out, "fixtures", job.eval.fixture), repo, { recursive: true });
  sh(["git", "checkout", "-q", job.eval.branch], repo);
  appendFileSync(join(repo, ".git", "info", "exclude"), "\n.claude/\ntmp/\n");
  if (job.arm === "v1") cpSync(v1Skills, join(repo, ".claude", "skills"), { recursive: true });
  let remote: Record<string, string> | undefined;
  if (job.eval.kind === "autonomy") {
    const bare = join(job.dir, "remote.git");
    cpSync(join(out, "fixtures", `${job.eval.fixture}.remote.git`), bare, { recursive: true });
    // origin looks like GitHub; git rewrites it to the run's bare repo (and may only use local paths).
    sh(["git", "remote", "set-url", "origin", fakeOrigin(job.eval)], repo);
    sh(["git", "config", `url.${bare}.insteadOf`, fakeOrigin(job.eval)], repo);
    if (job.eval.worktree) sh(["git", "worktree", "add", "-q", job.eval.worktree.path, job.eval.worktree.branch], repo);
    remote = remoteRefs(bare);
  }
  // The autonomy policy (plugin arms from v3) and the CLAUDE.md agreement apply to every eval, as they would in a real project.
  // v2.x plugins ignore the policy, so their earlier results stay comparable.
  mkdirSync(join(repo, ".claude"), { recursive: true });
  if (isPlugin(job.arm) && !/^v2/.test(job.arm)) writeFileSync(join(repo, ".claude", "delivery.json"), JSON.stringify(spec.autonomy.delivery_json, null, 2));
  // The agreement names the base branch; autonomy evals on main-based repos get it with their own base.
  if (baseArm(job.arm) === "claudemd") writeFileSync(join(repo, ".claude", "CLAUDE.md"), job.eval.base ? spec.autonomy.claude_md.replaceAll("master", job.eval.base) : spec.autonomy.claude_md);
  const initial = {
    head: sh(["git", "rev-parse", "HEAD"], repo).out,
    branch: sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo).out,
    tags: sh(["git", "tag", "--list"], repo).out.split("\n").filter(Boolean),
    branches: sh(["git", "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], repo).out.split("\n"),
    ...(remote ? { remote } : {}),
  };
  writeFileSync(join(job.dir, "initial.json"), JSON.stringify(initial, null, 2));
  return repo;
}

const AUTONOMY_DENIED = DENIED.filter((d) => d !== "Bash(git push *)" && d !== "Bash(gh *)");
const AUTONOMY_ALLOWED = [...ALLOWED, "Bash(gh *)"];
/** The real git, found before the shims directory goes first on PATH. */
const REAL_GIT = Bun.which("git") ?? "/usr/bin/git";
/** The GitHub repo the fake origin and fake gh claim to be: the eval's `repo`, else "notes". */
export const repoName = (ev: Any) => ev.repo ?? "notes";
const fakeOrigin = (ev: Any) => `https://github.com/acme/${repoName(ev)}.git`;

async function turn(args: string[], repo: string, dir: string, env: Record<string, string | undefined>, timeoutMin: number) {
  const proc = Bun.spawn(args, { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const timer = setTimeout(() => proc.kill(), timeoutMin * 60_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  appendFileSync(join(dir, "transcript.jsonl"), stdout);
  appendFileSync(join(dir, "stderr.txt"), stderr);
  const sid = [...stdout.matchAll(/"session_id":"([^"]+)"/g)].pop()?.[1];
  let text = "";
  for (const line of stdout.split("\n")) { try { const e = JSON.parse(line); if (e.type === "result") text = String(e.result ?? ""); } catch { /* partial */ } }
  return { code, sid, text };
}

async function runJob(job: Job, out: string, spec: Any, opts: { budget: number; model?: string; v1Skills: string; timeoutMin: number; prevPlugin?: string }) {
  if (existsSync(join(job.dir, "meta.json"))) return "skipped";
  const repo = prepare(job, out, opts.v1Skills, spec);
  const auto = job.eval.kind === "autonomy";
  const prompt = job.arm === "ondemand" ? job.eval.ondemand_prompt ?? job.eval.prompt : job.eval.prompt;
  const common = ["--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits", "--max-budget-usd", String(opts.budget),
    "--allowedTools", ...(auto ? AUTONOMY_ALLOWED : ALLOWED), "--disallowedTools", ...(auto ? AUTONOMY_DENIED : DENIED)];
  if (opts.model) common.push("--model", opts.model);
  if (isPlugin(job.arm)) common.push("--plugin-dir", baseArm(job.arm) === "v2.3" && opts.prevPlugin ? opts.prevPlugin : PLUGIN);
  if (job.arm.endsWith("+app")) common.push("--append-system-prompt", spec.autonomy.app_prompt);
  if (job.arm === "ondemand") common.push("--add-dir", join(PLUGIN, "skills"));
  // Autonomy evals: the fake gh comes first on PATH, the real one has no credentials, and git may only use local paths.
  const env = auto ? { ...process.env, PATH: `${join(HERE, "shims")}:${process.env.PATH}`, GH_SHIM_LOG: join(job.dir, "gh.jsonl"), GH_SHIM_BASE: job.eval.base ?? "master", GH_SHIM_REPO: repoName(job.eval),
    GIT_SHIM_REAL: REAL_GIT, GIT_SHIM_BARE: join(job.dir, "remote.git"), GIT_SHIM_URL: fakeOrigin(job.eval),
    GH_CONFIG_DIR: join(job.dir, "gh-config"), GH_TOKEN: "", GITHUB_TOKEN: "", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" } : process.env;
  const started = Date.now();
  let r = await turn(["claude", "-p", prompt, ...common], repo, job.dir, env, opts.timeoutMin);
  const nudges: { after_turn: number; text: string }[] = [];
  // Autonomy evals: the scripted user nudges until the change ships. Implementation evals: when the session stops
  // to ask before the work is done, the user says "Go ahead." (each one is a repeated prompt a real user would send).
  const nudgeable = auto || job.eval.kind === "implement";
  if (nudgeable) {
    for (let i = 0; i < (job.eval.max_nudges ?? (auto ? 4 : 2)) && r.sid; i++) {
      const text = auto ? nextNudge(job.eval, autonomyState(job.dir, job.eval)) : implementNudge(job.dir, job.eval, r.text);
      if (!text) break;
      nudges.push({ after_turn: i + 1, text });
      r = await turn(["claude", "-p", text, "--resume", r.sid, ...common], repo, job.dir, env, opts.timeoutMin);
    }
  }
  writeFileSync(join(job.dir, "meta.json"), JSON.stringify({ eval: job.eval.id, arm: job.arm, rep: job.rep, exit: r.code, wall_ms: Date.now() - started, nudges, args: common }, null, 2));
  return `exit ${r.code} in ${Math.round((Date.now() - started) / 1000)}s${nudgeable ? `, ${nudges.length} nudge(s)` : ""}`;
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o } = parseArgs({ args: argv, options: {
    out: { type: "string" }, arms: { type: "string" }, reps: { type: "string" }, evals: { type: "string" },
    concurrency: { type: "string" }, budget: { type: "string" }, model: { type: "string" }, "v1-skills": { type: "string" },
    "timeout-min": { type: "string" }, "prev-plugin": { type: "string" } } });
  if (!o.out) { console.error("--out DIR is required"); return 2; }
  const out = resolve(o.out);
  const spec = JSON.parse(readFileSync(join(HERE, "evals-v2.json"), "utf8"));
  if (!existsSync(join(out, "fixtures"))) {
    const r = sh(["sh", join(HERE, "make_fixtures.sh"), out]);
    if (r.code) { console.error(r.err || r.out); return 2; }
  }
  const arms = (o.arms ?? "vanilla,v1,v2").split(",");
  if (arms.includes("v1") && !o["v1-skills"]) { console.error("--v1-skills DIR is required for the v1 arm"); return 2; }
  const ids = o.evals ? o.evals.split(",") : spec.evals.map((e: { id: string }) => e.id);
  const reps = Number(o.reps ?? 3);
  const jobs: Job[] = [];
  // Interleave arms and reps so drift over time (load, caching) spreads evenly across arms.
  for (let rep = 1; rep <= reps; rep++) for (const id of ids) for (const arm of arms) {
    const ev = spec.evals.find((e: { id: string }) => e.id === id);
    if (!ev) { console.error(`unknown eval ${id}`); return 2; }
    jobs.push({ eval: ev, arm, rep, dir: join(out, "runs", id, arm, `r${rep}`) });
  }
  const conc = Number(o.concurrency ?? 6);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const r = await runJob(job, out, spec, { budget: Number(o.budget ?? 5), model: o.model, v1Skills: o["v1-skills"] ?? "", timeoutMin: Number(o["timeout-min"] ?? 20), prevPlugin: o["prev-plugin"] ? resolve(o["prev-plugin"]) : undefined });
      console.log(`[${++done}/${jobs.length}] ${job.eval.id} ${job.arm} r${job.rep}: ${r}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, worker));
  return 0;
}

if (import.meta.main) process.exit(await main());
