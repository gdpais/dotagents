#!/usr/bin/env bun
/**
 * Stage 2 head-to-head: run each eval under each arm as a real, headless Claude Code session
 * (`claude -p`, the user's normal setup), one fresh session per (eval, arm, repetition) in its own copy
 * of the fixture. Skill arms are forced with the skill's slash command at the start of the prompt; the
 * session's saved transcript must show the skill expanded, or the run is retried.
 *
 * Usage:
 *   bun run.ts --out DIR --sre DIR --review-skill DIR [--engineering DIR] [--evals id,...] [--arms none,custom]
 *              [--reps 5] [--concurrency 5] [--budget 8] [--model MODEL] [--timeout-min 25]
 *
 *   --sre          the sre plugin dir, or a folder of skill dirs (the five sre skills are taken from it)
 *   --review-skill defect-first-review's skill dir
 *   --engineering  the engineering plugin dir (default: the synced copy under ~/.claude/plugins/synced)
 *
 * Arms (per family, see evals.json): every arm gets the same plugins except the skills under test.
 *   incident  none | engineering (/engineering:incident-response) | custom (/sre:<stage skill of the eval>)
 *   review    none | engineering (/engineering:code-review) | builtin (/code-review) | custom (/delivery:defect-first-review)
 * Skills that would compete are removed, not just left unforced: a trimmed copy of the engineering plugin
 * shadows the synced one, a "delivery" plugin dir shadows the installed one (hooks included, so no arm
 * gets delivery's hooks), and built-ins and the ~/.claude/skills copies are hidden with skillOverrides.
 *
 * Fixtures are rebuilt into DIR/fixtures when missing (make_incident_fixtures.py, make_review_fixtures.sh);
 * answer keys stay in ./keys and never reach a session's folder. Each run writes
 * DIR/runs/<eval>/<arm>/r<n>/{work/, transcript.jsonl, session.jsonl, stderr.txt, meta.json}.
 * Finished runs are skipped, so the command resumes.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = import.meta.dir;
type Any = any;

export const ALLOWED = ["Read", "Edit", "Write", "Glob", "Grep", "Skill", "Agent", "Task", "TodoWrite",
  ...["git", "bun", "bunx", "node", "python3", "ls", "cat", "grep", "rg", "find", "sed", "awk", "head", "tail", "wc", "diff", "sort", "uniq",
    "cut", "tr", "jq", "date", "echo", "printf", "cd", "pwd", "test", "true", "xargs", "tee", "mkdir", "cp", "mv", "touch", "basename", "dirname", "realpath"].map((c) => `Bash(${c} *)`)];
export const DENIED = ["Bash(git push *)", "Bash(git commit *)", "Bash(gh *)", "Bash(curl *)", "Bash(wget *)", "WebFetch", "WebSearch"];
const SRE = ["sre-incident-lifecycle", "incident-live-report", "incident-postmortem", "rca-investigation", "tech-email"];

const sh = (cmd: string[], cwd?: string) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};
const syncedEngineering = () => {
  const root = join(homedir(), ".claude", "plugins", "synced");
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    const p = join(root, d, "engineering~g2");
    if (existsSync(join(p, ".claude-plugin", "plugin.json"))) return p;
  }
  return "";
};

/** The skill each arm forces for an eval, or null for `none`. */
export function armSkill(ev: Any, arm: string): string | null {
  if (arm === "none") return null;
  if (arm === "custom") return ev.custom_skill;
  if (arm === "engineering") return ev.family === "incident" ? "engineering:incident-response" : "engineering:code-review";
  if (arm === "builtin") return "code-review";
  throw new Error(`unknown arm ${arm}`);
}

/** Plugin dirs and skillOverrides for one (family, arm). Built once into DIR/plugins. */
export function armSetup(out: string, family: string, arm: string, o: { sre: string; reviewSkill: string; engineering: string }) {
  const root = join(out, "plugins");
  const eng = (drop: string[]) => {
    const name = drop.length ? `engineering-minus-${drop.join("-")}` : "engineering-full";
    const dir = join(root, name);
    if (!existsSync(dir)) {
      cpSync(o.engineering, dir, { recursive: true });
      rmSync(join(dir, ".in_use"), { recursive: true, force: true });
      for (const s of drop) rmSync(join(dir, "skills", s), { recursive: true, force: true });
    }
    return dir;
  };
  const delivery = (withReview: boolean) => {
    const dir = join(root, withReview ? "delivery-review-only" : "delivery-empty");
    if (!existsSync(dir)) {
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "delivery", version: "0.0.0-h2h", description: "head-to-head stand-in: shadows the installed delivery plugin" }));
      if (withReview) cpSync(o.reviewSkill, join(dir, "skills", "defect-first-review"), { recursive: true });
    }
    return dir;
  };
  const sre = () => {
    const dir = join(root, "sre");
    if (!existsSync(dir)) {
      if (existsSync(join(o.sre, ".claude-plugin", "plugin.json"))) cpSync(o.sre, dir, { recursive: true });
      else {
        for (const s of SRE) cpSync(join(o.sre, s), join(dir, "skills", s), { recursive: true });
        mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
        writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sre", version: "0.0.0-h2h", description: "SRE incident skills" }));
      }
    }
    return dir;
  };
  // User-level copies in ~/.claude/skills and built-ins that would compete are hidden for every arm.
  const overrides: Record<string, string> = { "rca-investigation": "off", "tech-email": "off", "security-review": "off", debug: "off" };
  let plugins: string[];
  if (family === "incident") {
    plugins = [arm === "engineering" ? eng(["debug"]) : eng(["incident-response", "debug"]), delivery(false), ...(arm === "custom" ? [sre()] : [])];
  } else {
    plugins = [arm === "engineering" ? eng([]) : eng(["code-review"]), delivery(arm === "custom")];
    if (arm !== "builtin") overrides["code-review"] = "off";
  }
  return { plugins, overrides };
}

/** The session's saved transcript (~/.claude/projects/<cwd>/<sid>.jsonl), which records the slash-command expansion. */
export function savedTranscript(sid: string): string | null {
  const root = join(homedir(), ".claude", "projects");
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sid}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** Did the forced skill expand? The command tag names it and a meta message with the skill body follows. */
export function forcedSkillRan(saved: string, skill: string): { ok: boolean; level?: string | null } {
  const lines = saved.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const users = lines.filter((e: Any) => e.type === "user");
  const tagged = users.findIndex((e: Any) => JSON.stringify(e.message?.content ?? "").includes(`<command-name>/${skill}</command-name>`));
  if (tagged < 0) return { ok: false };
  const meta = users.slice(tagged + 1).find((e: Any) => e.isMeta);
  const body = meta ? JSON.stringify(meta.message?.content ?? "") : "";
  const level = skill === "code-review" ? (/\b(low|medium|high|xhigh|max)\b effort|effort[^a-z]{0,5}(low|medium|high|xhigh|max)/i.exec(body)?.slice(1).find(Boolean) ?? null) : undefined;
  return { ok: body.length > 200, level };
}

async function turn(args: string[], cwd: string, dir: string, timeoutMin: number) {
  const proc = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMin * 60_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  appendFileSync(join(dir, "transcript.jsonl"), stdout);
  appendFileSync(join(dir, "stderr.txt"), stderr);
  let sid: string | undefined, result: Any = null, model: string | undefined;
  for (const line of stdout.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.session_id) sid = e.session_id;
      if (e.type === "system" && e.subtype === "init") model = e.model;
      if (e.type === "result") result = e;
    } catch { /* partial */ }
  }
  return { code, sid, result, model };
}

interface Job { ev: Any; arm: string; rep: number; dir: string }

async function runJob(job: Job, out: string, o: Any) {
  if (existsSync(join(job.dir, "meta.json"))) return "skipped";
  const skill = armSkill(job.ev, job.arm);
  const { plugins, overrides } = armSetup(out, job.ev.family, job.arm, o);
  const common = ["--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--max-budget-usd", String(o.budget),
    "--settings", JSON.stringify({ skillOverrides: overrides }), ...plugins.flatMap((p) => ["--plugin-dir", p]),
    "--allowedTools", ...ALLOWED, "--disallowedTools", ...DENIED];
  if (o.model) common.push("--model", o.model);
  let attempt = 0, last: Any = null;
  while (attempt++ < 3) {
    rmSync(job.dir, { recursive: true, force: true });
    mkdirSync(job.dir, { recursive: true });
    const work = join(job.dir, "work");
    if (job.ev.fixture) cpSync(join(out, "fixtures", job.ev.fixture), work, { recursive: true });
    else mkdirSync(work);
    const prompt = skill ? `/${skill} ${job.ev.prompt}` : job.ev.prompt;
    const started = Date.now();
    const turns: Any[] = [];
    let r = await turn(["claude", "-p", prompt, ...common], work, job.dir, o.timeoutMin);
    turns.push({ prompt, cost: r.result?.total_cost_usd ?? null, turns: r.result?.num_turns ?? null, duration_ms: r.result?.duration_ms ?? null, subtype: r.result?.subtype ?? null, text: r.result?.result ?? "" });
    if (job.ev.turn2 && r.sid) {
      cpSync(join(out, "fixtures", job.ev.turn2.add, "inputs"), join(work, "inputs"), { recursive: true });
      r = await turn(["claude", "-p", job.ev.turn2.prompt, "--resume", r.sid, ...common], work, job.dir, o.timeoutMin);
      turns.push({ prompt: job.ev.turn2.prompt, cost: r.result?.total_cost_usd ?? null, turns: r.result?.num_turns ?? null, duration_ms: r.result?.duration_ms ?? null, subtype: r.result?.subtype ?? null, text: r.result?.result ?? "" });
    }
    const saved = r.sid ? savedTranscript(r.sid) : null;
    if (saved) cpSync(saved, join(job.dir, "session.jsonl"));
    const forced = skill ? (saved ? forcedSkillRan(readFileSync(saved, "utf8"), skill) : { ok: false }) : { ok: true };
    // total_cost_usd is cumulative over a resumed session: the last turn's figure is the session's cost.
    last = { eval: job.ev.id, family: job.ev.family, arm: job.arm, rep: job.rep, skill, forced_ok: forced.ok, code_review_level: (forced as Any).level,
      attempt, model: r.model, exit: r.code, cost_usd: turns[turns.length - 1].cost, wall_ms: Date.now() - started, turns, sid: r.sid, args: common };
    if (forced.ok) break;
    appendFileSync(join(out, "retries.jsonl"), JSON.stringify({ eval: job.ev.id, arm: job.arm, rep: job.rep, attempt, cost_usd: last.cost_usd }) + "\n");
  }
  writeFileSync(join(job.dir, "meta.json"), JSON.stringify(last, null, 2));
  return `${last.forced_ok ? "" : "SKILL NOT CONFIRMED, "}$${(last.cost_usd ?? 0).toFixed(3)} in ${Math.round(last.wall_ms / 1000)}s${attempt > 1 ? ` (attempt ${attempt})` : ""}`;
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o } = parseArgs({ args: argv, options: {
    out: { type: "string" }, sre: { type: "string" }, "review-skill": { type: "string" }, engineering: { type: "string" },
    evals: { type: "string" }, arms: { type: "string" }, reps: { type: "string" }, concurrency: { type: "string" },
    budget: { type: "string" }, model: { type: "string" }, "timeout-min": { type: "string" } } });
  if (!o.out || !o.sre || !o["review-skill"]) { console.error("--out, --sre and --review-skill are required"); return 2; }
  const out = resolve(o.out);
  const spec = JSON.parse(readFileSync(join(HERE, "evals.json"), "utf8"));
  if (!existsSync(join(out, "fixtures", "inc-2219"))) {
    const a = sh(["python3", "-I", join(HERE, "make_incident_fixtures.py"), out, join(out, "keys-check")]);
    const b = sh(["sh", join(HERE, "make_review_fixtures.sh"), out]);
    if (a.code || b.code) { console.error(a.err || b.err); return 2; }
  }
  const opts = { sre: resolve(o.sre), reviewSkill: resolve(o["review-skill"]), engineering: o.engineering ? resolve(o.engineering) : syncedEngineering(),
    budget: Number(o.budget ?? 8), model: o.model, timeoutMin: Number(o["timeout-min"] ?? 25) };
  if (!opts.engineering) { console.error("engineering plugin not found; pass --engineering"); return 2; }
  const ids = o.evals ? o.evals.split(",") : spec.evals.map((e: Any) => e.id);
  const reps = Number(o.reps ?? 5);
  const jobs: Job[] = [];
  // Interleave arms and repetitions so drift over time (load, caching) spreads evenly across arms.
  for (let rep = 1; rep <= reps; rep++) for (const id of ids) {
    const ev = spec.evals.find((e: Any) => e.id === id);
    if (!ev) { console.error(`unknown eval ${id}`); return 2; }
    const arms = Object.keys(spec.arms[ev.family]).filter((a) => !o.arms || o.arms.split(",").includes(a));
    for (const arm of arms) jobs.push({ ev, arm, rep, dir: join(out, "runs", id, arm, `r${rep}`) });
  }
  let next = 0, done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const r = await runJob(job, out, opts);
      console.log(`[${++done}/${jobs.length}] ${job.ev.id} ${job.arm} r${job.rep}: ${r}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Number(o.concurrency ?? 5), jobs.length) }, worker));
  return 0;
}

if (import.meta.main) process.exit(await main());
