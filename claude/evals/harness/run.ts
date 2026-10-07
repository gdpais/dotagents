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
 *   v2, v2.x the delivery plugin in its current state, loaded with --plugin-dir (skills + hooks)
 *   ondemand nothing installed; uses the eval's `ondemand_prompt`, which names the skill file or script
 *
 * Fixtures come from make_fixtures.sh (built into DIR/fixtures when missing).
 * Each run writes DIR/runs/<eval>/<arm>/r<n>/{repo/, transcript.jsonl, stderr.txt,
 * initial.json, meta.json}. Finished runs are skipped, so the command resumes.
 * Prompts are passed verbatim: nothing tells the agent which skills exist.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

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

interface Job { eval: { id: string; fixture: string; branch: string; prompt: string }; arm: string; rep: number; dir: string }

function prepare(job: Job, out: string, v1Skills: string) {
  const repo = join(job.dir, "repo");
  mkdirSync(job.dir, { recursive: true });
  cpSync(join(out, "fixtures", job.eval.fixture), repo, { recursive: true });
  sh(["git", "checkout", "-q", job.eval.branch], repo);
  appendFileSync(join(repo, ".git", "info", "exclude"), "\n.claude/\ntmp/\n");
  if (job.arm === "v1") cpSync(v1Skills, join(repo, ".claude", "skills"), { recursive: true });
  const initial = {
    head: sh(["git", "rev-parse", "HEAD"], repo).out,
    branch: sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo).out,
    tags: sh(["git", "tag", "--list"], repo).out.split("\n").filter(Boolean),
    branches: sh(["git", "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], repo).out.split("\n"),
  };
  writeFileSync(join(job.dir, "initial.json"), JSON.stringify(initial, null, 2));
  return repo;
}

async function runJob(job: Job, out: string, opts: { budget: number; model?: string; v1Skills: string; timeoutMin: number }) {
  if (existsSync(join(job.dir, "meta.json"))) return "skipped";
  const repo = prepare(job, out, opts.v1Skills);
  const prompt = job.arm === "ondemand" ? (job.eval as { ondemand_prompt?: string }).ondemand_prompt ?? job.eval.prompt : job.eval.prompt;
  const args = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits", "--max-budget-usd", String(opts.budget),
    "--allowedTools", ...ALLOWED, "--disallowedTools", ...DENIED];
  if (opts.model) args.push("--model", opts.model);
  if (job.arm.startsWith("v2")) args.push("--plugin-dir", PLUGIN);
  if (job.arm === "ondemand") args.push("--add-dir", join(PLUGIN, "skills"));
  const started = Date.now();
  const proc = Bun.spawn(args, { cwd: repo, stdin: "ignore", stdout: Bun.file(join(job.dir, "transcript.jsonl")), stderr: Bun.file(join(job.dir, "stderr.txt")) });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMin * 60_000);
  const code = await proc.exited;
  clearTimeout(timer);
  writeFileSync(join(job.dir, "meta.json"), JSON.stringify({ eval: job.eval.id, arm: job.arm, rep: job.rep, exit: code, wall_ms: Date.now() - started, args: args.slice(3) }, null, 2));
  return `exit ${code} in ${Math.round((Date.now() - started) / 1000)}s`;
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o } = parseArgs({ args: argv, options: {
    out: { type: "string" }, arms: { type: "string" }, reps: { type: "string" }, evals: { type: "string" },
    concurrency: { type: "string" }, budget: { type: "string" }, model: { type: "string" }, "v1-skills": { type: "string" },
    "timeout-min": { type: "string" } } });
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
      const r = await runJob(job, out, { budget: Number(o.budget ?? 5), model: o.model, v1Skills: o["v1-skills"] ?? "", timeoutMin: Number(o["timeout-min"] ?? 20) });
      console.log(`[${++done}/${jobs.length}] ${job.eval.id} ${job.arm} r${job.rep}: ${r}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, worker));
  return 0;
}

if (import.meta.main) process.exit(await main());
