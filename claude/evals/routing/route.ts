#!/usr/bin/env bun
/**
 * Routing test (stage 1): which skill does Claude Code invoke for a natural request when the custom
 * incident and review skills compete with engineering:incident-response, engineering:code-review and
 * the built-in code-review? One fresh `claude -p` session per (prompt, arm, repetition) in its own copy
 * of a fixture; the session is stopped at the first Skill call, else it ends by itself or at --max-turns.
 *
 * Usage:
 *   bun route.ts --out DIR --sre DIR --delivery DIR [--review-skill DIR] [--engineering DIR]
 *                [--arms all,engineering-only] [--reps 3] [--ids i01,r02] [--concurrency 6]
 *                [--max-turns 6] [--budget 1] [--model MODEL] [--check-only]
 *
 *   --sre          the sre plugin dir, or a folder of skill dirs (built into a plugin named "sre")
 *   --delivery     the delivery plugin dir; it replaces the user-installed delivery plugin for the session
 *   --review-skill defect-first-review's skill dir, added to the delivery copy when it lacks one
 *   --engineering  only if the synced engineering plugin does not load in `claude -p` on its own
 *
 * Arms:
 *   all               sre + delivery (with defect-first-review) + everything the user has installed
 *   engineering-only  the same, minus sre and defect-first-review
 * Both arms hide the user-level copies in ~/.claude/skills (same bare names) with skillOverrides "off"
 * passed by --settings, so ~/.claude is never changed. Plugins are snapshotted into DIR/plugins on the first
 * run, so moving source paths cannot change a resumed run. Every run's init event is checked: each competing
 * skill must appear exactly once (all) or the custom ones not at all (engineering-only).
 *
 * Writes DIR/runs/<id>/<arm>/r<n>.jsonl (full stream) and appends one summary line per run to DIR/runs.jsonl.
 * Finished runs are skipped, so the command resumes.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = import.meta.dir;
type Any = any;

export const ARMS = ["all", "engineering-only"] as const;
const ALLOWED = ["Read", "Edit", "Write", "Glob", "Grep", "Skill", "Agent", "Task", "TodoWrite",
  ...["git", "bun", "ls", "cat", "grep", "rg", "find", "sed", "awk", "head", "tail", "wc", "diff", "jq", "python3"].map((c) => `Bash(${c} *)`)];
const DENIED = ["Bash(git push *)", "Bash(gh *)", "Bash(curl *)", "Bash(wget *)", "WebFetch", "WebSearch"];

const bare = (s: string) => s.split(":").pop()!;
const skillDirs = (dir: string) => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md"))).map((d) => d.name);
const isPlugin = (dir: string) => existsSync(join(dir, ".claude-plugin", "plugin.json"));

/** Snapshot the plugins once: DIR/plugins/all/{sre,delivery} and DIR/plugins/engineering-only/delivery. */
export function snapshot(out: string, o: { sre: string; delivery: string; reviewSkill?: string }, spec: Any) {
  const root = join(out, "plugins");
  if (existsSync(join(root, "manifest.json"))) return JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const sre = join(root, "all", "sre"), del = join(root, "all", "delivery"), delEng = join(root, "engineering-only", "delivery");
  if (isPlugin(o.sre)) cpSync(o.sre, sre, { recursive: true });
  else {
    // A plain skills folder holds other skills too: take only the ones the spec lists under sre:.
    for (const s of skillDirs(o.sre).filter((s) => spec.custom.includes(`sre:${s}`))) cpSync(join(o.sre, s), join(sre, "skills", s), { recursive: true });
    mkdirSync(join(sre, ".claude-plugin"), { recursive: true });
    writeFileSync(join(sre, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sre", version: "0.0.0-routing", description: "SRE incident skills (built for the routing test)" }, null, 2));
  }
  cpSync(o.delivery, del, { recursive: true });
  if (!existsSync(join(del, "skills", "defect-first-review"))) {
    if (!o.reviewSkill) throw new Error("--delivery has no skills/defect-first-review; pass --review-skill");
    cpSync(o.reviewSkill, join(del, "skills", "defect-first-review"), { recursive: true });
  }
  cpSync(del, delEng, { recursive: true });
  rmSync(join(delEng, "skills", "defect-first-review"), { recursive: true });
  for (const d of [sre, del, delEng]) rmSync(join(d, ".in_use"), { recursive: true, force: true });
  const manifest = {
    sources: { sre: resolve(o.sre), delivery: resolve(o.delivery), reviewSkill: o.reviewSkill && resolve(o.reviewSkill) },
    sre: skillDirs(join(sre, "skills")).map((s) => `sre:${s}`),
    delivery: skillDirs(join(del, "skills")).map((s) => `delivery:${s}`),
    taken: new Date().toISOString(),
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Init check: competing skills each listed once in "all"; custom ones absent in "engineering-only". */
export function checkInit(skills: string[], arm: string, spec: Any): string[] {
  const problems: string[] = [];
  const competing = [...new Set([...spec.competing.incident, ...spec.competing.review])] as string[];
  // The exact name plus any copy under the same bare name that is not itself a competitor
  // (engineering:code-review and the built-in code-review share a bare name on purpose).
  const copies = (name: string) => skills.filter((s) => s === name || (bare(s) === bare(name) && !competing.includes(s)));
  for (const name of competing) {
    const want = arm === "engineering-only" && spec.custom.includes(name) ? 0 : 1;
    const c = copies(name);
    if (c.length !== want || (want === 1 && !skills.includes(name))) problems.push(`${name}: listed as [${c.join(", ")}], want ${want}`);
  }
  return problems;
}

/** Map the Skill tool's `skill` argument to the listed name ("rca-investigation" -> "sre:rca-investigation"). */
export function canonical(skill: string, listed: string[]): string {
  if (listed.includes(skill)) return skill;
  const s = skill.replace(/^\//, "");
  const hits = listed.filter((l) => bare(l) === bare(s));
  return hits.length === 1 ? hits[0] : s;
}

interface Job { p: Any; arm: string; rep: number; file: string; slot?: number }

async function runJob(job: Job, out: string, spec: Any, manifest: Any, o: { maxTurns: number; budget: number; model?: string; engineering?: string; timeoutMin: number }) {
  // One fixed folder per worker and fixture: the system prompt (cwd, git status) repeats, so the prompt cache is reused.
  const dir = join(out, "work", `w${job.slot ?? 0}`, job.p.fixture);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(out, "fixtures", job.p.fixture), dir, { recursive: true });
  const plugins = job.arm === "all" ? [join(out, "plugins", "all", "sre"), join(out, "plugins", "all", "delivery")] : [join(out, "plugins", "engineering-only", "delivery")];
  if (o.engineering) plugins.push(o.engineering);
  // User-level copies (~/.claude/skills) share the custom skills' bare names: hide them for this session only.
  const overrides = Object.fromEntries(spec.custom.map((s: string) => [bare(s), "off"]));
  const args = ["claude", "-p", job.p.prompt, "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits", "--max-turns", String(o.maxTurns), "--max-budget-usd", String(o.budget),
    "--settings", JSON.stringify({ skillOverrides: overrides }),
    ...plugins.flatMap((p) => ["--plugin-dir", p]),
    "--allowedTools", ...ALLOWED, "--disallowedTools", ...DENIED];
  if (o.model) args.push("--model", o.model);
  mkdirSync(join(out, "runs", job.p.id, job.arm), { recursive: true });
  writeFileSync(job.file, "");
  const started = Date.now();
  const proc = Bun.spawn(args, { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let killedBy: string | null = null;
  const timer = setTimeout(() => { killedBy = "timeout"; proc.kill(); }, o.timeoutMin * 60_000);
  const rec: Any = { id: job.p.id, family: job.p.family, kind: job.p.kind, arm: job.arm, rep: job.rep, model: null, version: null,
    init_problems: null, skill: null, skill_raw: null, skill_turn: null, tools_before: [], end: null, turns: 0,
    usage: [], cost_usd: null, result_subtype: null, text: "", wall_ms: 0 };
  let listed: string[] = [];
  const seenMsg = new Set<string>();
  const usageById = new Map<string, Any>();
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line: string) => {
    if (!line.trim()) return;
    appendFileSync(job.file, line + "\n");
    let e: Any; try { e = JSON.parse(line); } catch { return; }
    if (e.type === "system" && e.subtype === "init") {
      listed = e.skills ?? [];
      rec.model = e.model; rec.version = e.claude_code_version;
      rec.init_problems = checkInit(listed, job.arm, spec);
      rec.plugins = (e.plugins ?? []).map((p: Any) => p.source);
    }
    if (e.type === "assistant" && e.message) {
      const m = e.message;
      // A message streams as several events; the last one carries its final token counts.
      if (!e.parent_tool_use_id && m.id && !seenMsg.has(m.id)) { seenMsg.add(m.id); rec.turns++; }
      if (m.id && m.usage) usageById.set(m.id, { model: m.model, sub: !!e.parent_tool_use_id, ...m.usage });
      for (const b of m.content ?? []) {
        if (b.type === "text" && !e.parent_tool_use_id) rec.text = (rec.text + b.text).slice(-600);
        if (b.type !== "tool_use") continue;
        if (b.name === "Skill" && rec.skill === null) {
          rec.skill_raw = String(b.input?.skill ?? b.input?.command ?? "");
          rec.skill = canonical(rec.skill_raw, listed);
          rec.skill_turn = rec.turns;
          rec.skill_in_subagent = !!e.parent_tool_use_id;
          rec.skill_args = b.input?.args ?? null;
          killedBy = "skill"; proc.kill();
        } else if (rec.skill === null) rec.tools_before.push(b.name === "Bash" ? `Bash(${String(b.input?.command ?? "").slice(0, 80)})` : b.name);
      }
    }
    if (e.type === "result") {
      rec.cost_usd = e.total_cost_usd ?? null; rec.result_subtype = e.subtype; rec.num_turns = e.num_turns;
      rec.model_usage = e.modelUsage ?? null;
    }
  };
  const reader = proc.stdout.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  handle(buf);
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  clearTimeout(timer);
  rec.wall_ms = Date.now() - started;
  rec.usage = [...usageById.values()];
  rec.end = killedBy ?? (rec.result_subtype === "error_max_turns" ? "max_turns" : rec.result_subtype ? "answered" : `exit ${proc.exitCode}`);
  if (rec.end.startsWith("exit")) rec.stderr = stderr.slice(-400);
  appendFileSync(join(out, "runs.jsonl"), JSON.stringify(rec) + "\n");
  rmSync(dir, { recursive: true, force: true });
  return rec;
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o } = parseArgs({ args: argv, options: {
    out: { type: "string" }, sre: { type: "string" }, delivery: { type: "string" }, "review-skill": { type: "string" },
    engineering: { type: "string" }, arms: { type: "string" }, reps: { type: "string" }, ids: { type: "string" },
    concurrency: { type: "string" }, "max-turns": { type: "string" }, budget: { type: "string" }, model: { type: "string" },
    "timeout-min": { type: "string" }, prompts: { type: "string" }, "check-only": { type: "boolean" } } });
  if (!o.out || !o.sre || !o.delivery) { console.error("--out, --sre and --delivery are required"); return 2; }
  const out = resolve(o.out);
  mkdirSync(out, { recursive: true });
  const spec = JSON.parse(readFileSync(o.prompts ?? join(HERE, "prompts.json"), "utf8"));
  if (!existsSync(join(out, "fixtures"))) {
    const r = Bun.spawnSync(["sh", join(HERE, "make_fixtures.sh"), out], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode) { console.error(r.stderr.toString()); return 2; }
  }
  const manifest = snapshot(out, { sre: resolve(o.sre), delivery: resolve(o.delivery), reviewSkill: o["review-skill"] && resolve(o["review-skill"]) }, spec);
  const arms = (o.arms ?? ARMS.join(",")).split(",");
  const ids = o.ids ? o.ids.split(",") : spec.prompts.map((p: Any) => p.id);
  const reps = Number(o.reps ?? 3);
  const done = new Set(existsSync(join(out, "runs.jsonl"))
    ? readFileSync(join(out, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.id}/${r.arm}/${r.rep}`; }) : []);
  const jobs: Job[] = [];
  // Interleave arms and repetitions so drift over time (load, caching) spreads evenly.
  for (let rep = 1; rep <= reps; rep++) for (const id of ids) for (const arm of arms) {
    const p = spec.prompts.find((x: Any) => x.id === id);
    if (!p) { console.error(`unknown prompt ${id}`); return 2; }
    if (!done.has(`${id}/${arm}/${rep}`)) jobs.push({ p, arm, rep, file: join(out, "runs", id, arm, `r${rep}.jsonl`) });
  }
  const opts = { maxTurns: Number(o["max-turns"] ?? 6), budget: Number(o.budget ?? 1), model: o.model, engineering: o.engineering && resolve(o.engineering), timeoutMin: Number(o["timeout-min"] ?? 6) };
  if (o["check-only"]) {
    // One cheap session per arm to show the init check before spending on the full set.
    for (const arm of arms) {
      const r = await runJob({ p: { ...spec.prompts.find((x: Any) => x.id === "in3"), id: "_check" }, arm, rep: 0, file: join(out, "runs", "_check", arm, "r0.jsonl") }, out, spec, manifest, { ...opts, maxTurns: 1 });
      console.log(arm, r.model, r.version, r.init_problems?.length ? r.init_problems : "init ok", r.plugins);
    }
    return 0;
  }
  console.log(`${jobs.length} runs; snapshot ${JSON.stringify(manifest.sources)}`);
  let next = 0, n = 0;
  const worker = async (slot: number) => {
    while (next < jobs.length) {
      const job = { ...jobs[next++], slot };
      const r = await runJob(job, out, spec, manifest, opts);
      console.log(`[${++n}/${jobs.length}] ${job.p.id} ${job.arm} r${job.rep}: ${r.skill ?? "none"} (${r.end}, ${r.turns} turns${r.init_problems?.length ? `, INIT: ${r.init_problems.join("; ")}` : ""})`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Number(o.concurrency ?? 6), jobs.length) }, (_, k) => worker(k)));
  return 0;
}

if (import.meta.main) process.exit(await main());
