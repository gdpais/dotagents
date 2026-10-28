#!/usr/bin/env bun
/**
 * Aggregate Claude Code transcripts into the datasets behind the "Skills and workflows usage" dashboard.
 *
 * Reads every ~/.claude/projects/<project>/<session>.jsonl (and <session>/subagents/*.jsonl) and writes
 * one JSON file of row objects per dataset: kpis, skills, skill_daily, workflows, gate, daily, models,
 * projects, tools, hours, guardrails. Each row carries a `scope`: "interactive" (your own sessions),
 * "automated" (eval harness runs, graders, probes) or "all" (both, where summing makes sense).
 *
 * Custom skills, their workflows and origins come from this repository: claude/skills/<name>,
 * claude/plugins/<plugin>/skills/<name>, the skills table in claude/README.md and claude/workflows/<name>.
 * Days and hours are local time. Cost is Claude Code's own estimate (cost-state records), not a bill.
 *
 * Usage: usage_report.ts [--projects DIR] [--out DIR] [--root DIR]
 *   --projects  transcripts folder (default ~/.claude/projects)
 *   --out       where the JSON files go (default ~/.claude/usage-report; kept out of the repo on purpose)
 *   --root      the repo's claude/ folder (default: the folder above tools/)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

// Anthropic skills the delivery workflow hands off to (claude/README.md).
export const DELIVERY_SUPPORT = new Set(["security-review", "engineering:deploy-checklist", "engineering:architecture", "engineering:system-design",
  "engineering:testing-strategy", "engineering:debug", "engineering:tech-debt", "engineering:documentation"]);
const BUILTIN_COMMANDS = new Set(["model", "login", "logout", "config", "effort", "remote-control", "web-setup", "auto-mode-setup", "clear", "compact",
  "resume", "plugin", "mcp", "help", "status", "cost", "permissions", "hooks", "agents", "memory", "init", "fast", "context", "usage", "exit", "rewind",
  "add-dir", "doctor", "terminal-setup", "output-style", "ide", "theme", "vim", "export", "feedback", "bug", "upgrade"]);
const NOT_PROMPTS = ["<command-", "<local-command", "<task-notification", "<side-sessions-event", "<ci-monitor-event", "Caveat:", "[Request interrupted"];
const SCOPES = ["interactive", "automated"] as const;
type Scope = (typeof SCOPES)[number];
type Row = Record<string, string | number>;

export interface Catalog {
  /** custom skill -> [workflow, origin] */
  custom: Map<string, [string, string]>;
  /** namespaces that may prefix a custom skill's name (plugin names, anthropic-skills) */
  prefixes: Set<string>;
  workflows: string[];
}

const dirs = (p: string) => (existsSync(p) ? readdirSync(p).filter((n) => !n.startsWith(".") && statSync(join(p, n)).isDirectory()).sort() : []);

/** Custom skills, workflows and origins as this repository defines them. */
export function loadCatalog(root: string): Catalog {
  const custom = new Map<string, [string, string]>();
  const readme = existsSync(join(root, "README.md")) ? readFileSync(join(root, "README.md"), "utf8") : "";
  const table = new Map([...readme.matchAll(/^\|\s*([a-z0-9-]+)\s*\|\s*([a-z0-9-]+)\s*\|/gm)].map((m) => [m[1], m[2]] as [string, string]));
  for (const s of dirs(join(root, "skills"))) custom.set(s, [table.get(s) ?? "standalone", "Custom skill"]);
  const prefixes = new Set(["anthropic-skills"]);
  for (const p of dirs(join(root, "plugins"))) {
    prefixes.add(p);
    for (const s of dirs(join(root, "plugins", p, "skills"))) custom.set(s, [p, p[0].toUpperCase() + p.slice(1) + " plugin"]);
  }
  const workflows = dirs(join(root, "workflows"));
  const own = (w: string) => [...custom.values()].filter(([wf]) => wf === w).length;
  workflows.sort((a, b) => own(b) - own(a) || a.localeCompare(b));
  return { custom, prefixes, workflows };
}

export function canon(name: string, cat: Catalog): string {
  name = name.replace(/^\//, "");
  const i = name.indexOf(":");
  if (i > 0 && cat.prefixes.has(name.slice(0, i)) && cat.custom.has(name.slice(i + 1))) return name.slice(i + 1);
  return name;
}

export function originOf(skill: string, cat: Catalog): string {
  if (cat.custom.has(skill)) return cat.custom.get(skill)![1];
  if (skill.startsWith("engineering:")) return "Engineering plugin";
  if (skill.includes(":") && !skill.startsWith("anthropic-skills:")) return "Other plugin";
  return "Anthropic built-in";
}

const workflowOf = (skill: string, cat: Catalog) => cat.custom.get(skill)?.[0] ?? (DELIVERY_SUPPORT.has(skill) ? "delivery" : "standalone");

/** -> [scope, project label] for a transcript folder name and the session's working directory. */
export function classify(projDir: string, cwd: string | undefined, home = homedir()): [Scope, string] {
  if (projDir.startsWith("-private-var-folders-") && projDir.includes("grader")) return ["automated", "Eval graders"];
  const m = /scratchpad-(evals\d*|it\d+|pilot|smoke)/.exec(projDir);
  if (m) {
    const g = m[1];
    if (g === "pilot" || g === "smoke") return ["automated", "Eval pilot and smoke runs"];
    return ["automated", "Delivery evals " + (g.startsWith("evals") ? "it" + (g.slice(5) || "1") : g)];
  }
  if (projDir.startsWith("-private-")) return ["automated", "Other automated runs"];
  if (projDir.includes("CodexBar")) return ["automated", "CodexBar usage probe"];
  if (projDir.includes("scratch-workspaces")) return ["interactive", "App scratch chats"];
  const c = (cwd ?? "").split("/.claude/worktrees/")[0].replace(/\/+$/, "");
  if (c === home.replace(/\/+$/, "")) return ["interactive", "Home folder"];
  if (c.endsWith("/.claude/skills") || c.endsWith("/.codex/skills")) return ["interactive", "~/" + c.split("/").slice(-2).join("/")];
  return ["interactive", basename(c) || projDir];
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const r2 = (x: number) => Math.round(x * 100) / 100;
const toolLabel = (n: string) => (n.startsWith("mcp__") && n.split("__").length >= 3 ? "MCP: " + n.split("__")[1] : n);

class Counter<K = string> extends Map<K, number> {
  add(k: K, n = 1) { this.set(k, (this.get(k) ?? 0) + n); }
  n(k: K) { return this.get(k) ?? 0; }
}
const key = (...p: (string | number)[]) => p.join("\u0000");
const unkey = (k: string) => k.split("\u0000");

function jsonlFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsonlFiles(p, out);
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

interface Session {
  scope: Scope; project: string; start?: Date; end?: Date; cost: number; added: number; removed: number;
  prompts: number; turns: number; days: Set<string>; modelCost: Map<string, number>;
}

/** Add scope="all" rows that sum `sums` over both scopes, grouped by `keys`. */
function withAll(rows: Row[], keys: string[], sums: string[]): Row[] {
  const agg = new Map<string, Row>();
  for (const r of rows) {
    const k = key(...keys.map((x) => r[x]));
    if (!agg.has(k)) agg.set(k, { ...Object.fromEntries(keys.map((x) => [x, r[x]])), scope: "all", ...Object.fromEntries(sums.map((x) => [x, 0])) });
    const a = agg.get(k)!;
    for (const x of sums) a[x] = (a[x] as number) + (r[x] as number);
  }
  for (const a of agg.values()) for (const x of sums) if (x.endsWith("usd")) a[x] = r2(a[x] as number);
  return [...rows, ...agg.values()];
}
const sorted = <V>(m: Map<string, V>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export function aggregate(projectsDir: string, cat: Catalog, home = homedir()): Record<string, Row[]> {
  const sessions = new Map<string, Session>();
  const skillInv = new Counter(), skillAttr = new Counter(), skillAttrOut = new Counter(), skillDaily = new Counter();
  const skillSessions = new Map<string, Set<string>>(), skillFirst = new Map<string, string>(), skillLast = new Map<string, string>();
  const daily = new Map<string, Counter>(), models = new Map<string, Counter>(), tools = new Map<string, Counter>();
  const agents = new Counter(), hours = new Counter(), perms = new Counter(), apiErr = new Counter(), gate = new Counter(), workflowTool = new Counter();
  const prs = new Map<string, [Scope, string, string | undefined]>();
  const seenMsg = new Set<string>(), seenTool = new Set<string>();
  const bucket = (m: Map<string, Counter>, k: string) => { if (!m.has(k)) m.set(k, new Counter()); return m.get(k)!; };
  const noteSkill = (scope: Scope, sk: string, how: string, sid: string, day?: string) => {
    skillInv.add(key(scope, sk, how));
    const sk2 = key(scope, sk);
    if (!skillSessions.has(sk2)) skillSessions.set(sk2, new Set());
    skillSessions.get(sk2)!.add(sid);
    if (day) {
      skillDaily.add(key(scope, day, originOf(sk, cat)));
      if (!skillFirst.has(sk) || day < skillFirst.get(sk)!) skillFirst.set(sk, day);
      if (!skillLast.has(sk) || day > skillLast.get(sk)!) skillLast.set(sk, day);
    }
  };

  // Main transcripts first, so a session takes its project from where it started, not from a subagent's cwd.
  const isSubagent = (f: string) => relative(projectsDir, f).split(sep).includes("subagents");
  const files = jsonlFiles(projectsDir).sort((a, b) => Number(isSubagent(a)) - Number(isSubagent(b)));
  for (const f of files) {
    const parts = relative(projectsDir, f).split(sep);
    const projDir = parts[0];
    const isSub = parts.includes("subagents");
    const sid = isSub ? parts[1] : parts[1].replace(/\.jsonl$/, "");
    const recs: any[] = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      try { recs.push(JSON.parse(line)); } catch { /* a partly written line */ }
    }
    let s = sessions.get(sid);
    if (!s) {
      const [scope, project] = classify(projDir, recs.find((d) => d.cwd)?.cwd, home);
      s = { scope, project, cost: 0, added: 0, removed: 0, prompts: 0, turns: 0, days: new Set(), modelCost: new Map() };
      sessions.set(sid, s);
    }
    const scope = s.scope;
    const toolNames = new Map<string, string>();
    let day: string | undefined;
    for (const d of recs) {
      const t = d.type;
      const ts = d.timestamp ? new Date(d.timestamp) : undefined;
      if (ts && !isNaN(+ts)) {
        day = localDay(ts);
        if (!s.start || ts < s.start) s.start = ts;
        if (!s.end || ts > s.end) s.end = ts;
      }
      if (t === "cost-state" && !isSub) {
        const c = d.totalCostUSD ?? 0;
        if (c > s.cost) {
          if (day) bucket(daily, key(scope, day)).add("cost", c - s.cost);
          s.cost = c;
        }
        s.added = Math.max(s.added, d.totalLinesAdded ?? 0);
        s.removed = Math.max(s.removed, d.totalLinesRemoved ?? 0);
        for (const [m, u] of Object.entries<any>(d.modelUsage ?? {})) if ((u.costUSD ?? 0) > (s.modelCost.get(m) ?? 0)) s.modelCost.set(m, u.costUSD);
        continue;
      }
      if (t === "pr-link") {
        const k = key(d.prRepository, d.prNumber);
        if (!prs.has(k)) prs.set(k, [scope, s.project, ts ? localDay(ts) : day]);
        continue;
      }
      if (t === "system") {
        if (d.subtype === "api_error") {
          const e = JSON.stringify(d.error ?? d.content ?? "");
          const kind = e.includes("429") || e.includes("rate_limit") ? "Rate limit (429)" : e.includes("onnection") ? "Connection lost"
            : e.includes("401") ? "Auth (401)" : e.includes("529") || e.includes("overloaded") ? "Overloaded (529)" : "Other";
          apiErr.add(key(scope, kind));
        } else if (d.subtype === "stop_hook_summary") {
          for (const he of (d.hookErrors ?? []) as string[]) {
            if (!he.includes("stop_gate.ts") && !he.includes("delivery")) continue;
            if (he.includes("Plugin directory does not exist")) gate.add(key(scope, "Plugin error", "Plugin cache missing"));
            else if (he.includes("Delivery autonomy")) gate.add(key(scope, "Stop gate: autonomy nudge", "Unpushed work or no PR"));
            else {
              const cats = [...he.matchAll(/Review needed \(([a-z-]+)\)/g)].map((m) => m[1]);
              const failing = !cats.length && /(fail|lint|typecheck|tests?) /i.test(he);
              for (const c of cats.length ? cats : [failing ? "failing checks" : "other"]) gate.add(key(scope, "Stop gate: blocked", c));
            }
          }
        }
        continue;
      }
      const a = d.attachment;
      if (a) {
        const cmd: string = a.command ?? "";
        if (a.type === "hook_additional_context" && JSON.stringify(a.content).includes("Delivery autonomy")) gate.add(key(scope, "Autonomy policy loaded", "Session start"));
        else if (a.type === "hook_system_message" && String(a.content).includes("Delivery notes")) {
          for (const m of String(a.content).matchAll(/(?:^|; |\): )([a-z-]+): /g)) if (m[1] !== "blocking") gate.add(key(scope, "Stop gate: review note", m[1]));
        } else if (a.type === "hook_success" && ["stop_gate.ts", "bash_guard.ts", "session_context.ts", "hooks/run.sh"].some((x) => cmd.includes(x))) {
          gate.add(key(scope, "Gate runs", a.hookEvent || a.hookName || ""));
        } else if (a.type === "hook_non_blocking_error" && String(a.stderr).includes("delivery")) gate.add(key(scope, "Plugin error", "Plugin cache missing"));
        continue;
      }
      const pd = d.permissionDecision;
      if (pd && typeof pd === "object") {
        const rt = pd.reasonType ?? "";
        const allowed = pd.decision === "accept";
        const reason = pd.source === "hook" ? "Delivery hook" : pd.source === "user_temporary" ? "You, once"
          : ({ classifier: "Auto-mode classifier", subcommandResults: "Allowed subcommands", rule: "Allow/deny rule", mode: "Permission mode", safetyCheck: "Safety check" } as Record<string, string>)[rt]
            ?? (!rt && !allowed ? "Not pre-approved (headless)" : "Other");
        perms.add(key(scope, allowed ? "Allowed" : "Blocked", reason));
        if (pd.source === "hook") gate.add(key(scope, "Bash guard", allowed ? "Allowed" : "Asked / blocked"));
      }
      const m = d.message;
      if (!m || typeof m !== "object") continue;
      const content = m.content;
      if (t === "assistant") {
        const mid = m.id ?? d.uuid;
        if (!seenMsg.has(mid)) {
          seenMsg.add(mid);
          const u = m.usage ?? {};
          const model = m.model ?? "?";
          if (model !== "<synthetic>") {
            const mm = bucket(models, key(scope, model));
            mm.add("turns");
            for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) mm.add(k, u[k] ?? 0);
            if (day) { const dd = bucket(daily, key(scope, day)); dd.add("turns"); dd.add("output_tokens", u.output_tokens ?? 0); }
            s.turns++;
          }
          if (d.attributionSkill) {
            const c = canon(d.attributionSkill, cat);
            skillAttr.add(key(scope, c));
            skillAttrOut.add(key(scope, c), u.output_tokens ?? 0);
          }
        }
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type !== "tool_use" || seenTool.has(c.id)) continue;
            seenTool.add(c.id);
            const name: string = c.name ?? "?";
            toolNames.set(c.id, name);
            bucket(tools, key(scope, toolLabel(name))).add("calls");
            if (day) bucket(daily, key(scope, day)).add("tool_calls");
            const inp = c.input ?? {};
            if (name === "Skill" && inp.skill) noteSkill(scope, canon(inp.skill, cat), "model", sid, day);
            else if (name === "Agent" || name === "Task") {
              agents.add(key(scope, inp.subagent_type || "general-purpose"));
              if (day) bucket(daily, key(scope, day)).add("subagents");
            } else if (name === "Workflow") workflowTool.add(scope);
          }
        }
      } else if (t === "user") {
        const blocks: any[] = Array.isArray(content) ? content : [];
        for (const c of blocks) if (c?.type === "tool_result" && c.is_error) bucket(tools, key(scope, toolLabel(toolNames.get(c.tool_use_id) ?? "?"))).add("errors");
        const text = typeof content === "string" ? content : blocks.filter((c) => c?.type === "text").map((c) => c.text ?? "").join(" ");
        if (isSub || blocks.some((c) => c?.type === "tool_result") || d.isMeta || !text.trim()) continue;
        const cmd = /<command-name>\/?([^<]+)<\/command-name>/.exec(text);
        if (cmd && !BUILTIN_COMMANDS.has(cmd[1].trim())) noteSkill(scope, canon(cmd[1].trim(), cat), "slash", sid, day);
        if (!cmd && NOT_PROMPTS.some((p) => text.trimStart().startsWith(p))) continue;
        s.prompts++;
        if (day) { bucket(daily, key(scope, day)).add("prompts"); s.days.add(day); }
        if (ts && !isNaN(+ts)) hours.add(key(scope, (ts.getDay() + 6) % 7, ts.getHours()));
      }
    }
  }

  const live = [...sessions.values()].filter((s) => s.start && (s.turns || s.prompts));
  for (const s of live) bucket(daily, key(s.scope, localDay(s.start!))).add("sessions");
  for (const s of sessions.values()) for (const [m, c] of s.modelCost) bucket(models, key(s.scope, m)).add("cost", c);

  const scopesOf = (sc: string): readonly Scope[] => (sc === "all" ? SCOPES : [sc as Scope]);
  const ran = (scs: readonly Scope[], sk: string) => scs.reduce((a, x) => a + skillInv.n(key(x, sk, "model")) + skillInv.n(key(x, sk, "slash")), 0);
  const sessionsOf = (scs: readonly Scope[], names: string[]) => new Set(scs.flatMap((x) => names.flatMap((n) => [...(skillSessions.get(key(x, n)) ?? [])]))).size;
  const out: Record<string, Row[]> = {};

  const allSkills = new Set([...cat.custom.keys(), ...[...skillInv.keys()].map((k) => unkey(k)[1]), ...[...skillAttr.keys()].map((k) => unkey(k)[1])]);
  out.skills = [];
  for (const sc of [...SCOPES, "all"]) {
    const scs = scopesOf(sc);
    for (const sk of [...allSkills].sort()) {
      const byModel = scs.reduce((a, x) => a + skillInv.n(key(x, sk, "model")), 0), byYou = scs.reduce((a, x) => a + skillInv.n(key(x, sk, "slash")), 0);
      const turns = scs.reduce((a, x) => a + skillAttr.n(key(x, sk)), 0);
      if (!(byModel || byYou || turns) && !cat.custom.has(sk)) continue;
      out.skills.push({ scope: sc, skill: sk, origin: originOf(sk, cat), workflow: workflowOf(sk, cat), invocations: byModel + byYou, by_model: byModel, by_you: byYou,
        sessions: sessionsOf(scs, [sk]), turns, output_tokens: scs.reduce((a, x) => a + skillAttrOut.n(key(x, sk)), 0),
        first_used: skillFirst.get(sk) ?? "", last_used: skillLast.get(sk) ?? "" });
    }
  }

  out.skill_daily = withAll(sorted(skillDaily).map(([k, n]) => { const [scope, day, origin] = unkey(k); return { scope, day, origin, invocations: n }; }), ["day", "origin"], ["invocations"]);

  out.workflows = [];
  for (const sc of [...SCOPES, "all"]) {
    const scs = scopesOf(sc);
    for (const wf of cat.workflows) {
      const own = [...cat.custom.entries()].filter(([, [w]]) => w === wf).map(([n]) => n);
      const sup = wf === "delivery" ? [...DELIVERY_SUPPORT].sort() : [];
      const runs = (names: string[]) => names.reduce((a, n) => a + ran(scs, n), 0);
      out.workflows.push({ scope: sc, workflow: wf, custom_skills: own.length, skills_used: own.filter((n) => ran(scs, n)).length,
        custom_invocations: runs(own), support_invocations: runs(sup), sessions: sessionsOf(scs, [...own, ...sup]),
        turns: scs.reduce((a, x) => a + own.reduce((b, n) => b + skillAttr.n(key(x, n)), 0), 0),
        last_used: [...own, ...sup].filter((n) => ran(scs, n)).map((n) => skillLast.get(n) ?? "").sort().pop() ?? "" });
    }
  }

  for (const sc of SCOPES) for (const ev of ["SessionStart", "PreToolUse", "Stop"]) gate.add(key(sc, "Gate runs", ev), 0);
  out.gate = withAll(sorted(gate).map(([k, n]) => { const [scope, event, detail] = unkey(k); return { scope, event, detail, count: n }; }), ["event", "detail"], ["count"]);

  out.daily = withAll(sorted(daily).map(([k, m]) => {
    const [scope, day] = unkey(k);
    return { scope, day, sessions: m.n("sessions"), prompts: m.n("prompts"), turns: m.n("turns"), tool_calls: m.n("tool_calls"), subagents: m.n("subagents"),
      output_tokens: m.n("output_tokens"), cost_usd: r2(m.n("cost")) };
  }), ["day"], ["sessions", "prompts", "turns", "tool_calls", "subagents", "output_tokens", "cost_usd"]);

  out.models = withAll(sorted(models).filter(([k]) => unkey(k)[1] !== "?").map(([k, m]) => {
    const [scope, model] = unkey(k);
    return { scope, model, turns: m.n("turns"), input_tokens: m.n("input_tokens"), output_tokens: m.n("output_tokens"), cache_write_tokens: m.n("cache_creation_input_tokens"),
      cache_read_tokens: m.n("cache_read_input_tokens"), cost_usd: r2(m.n("cost")) };
  }), ["model"], ["turns", "input_tokens", "output_tokens", "cache_write_tokens", "cache_read_tokens", "cost_usd"]);

  const proj = new Map<string, Counter>();
  for (const s of [...sessions.values()].filter((s) => s.turns || s.prompts)) {
    const p = bucket(proj, key(s.scope, s.project));
    p.add("sessions"); p.add("cost", s.cost); p.add("prompts", s.prompts); p.add("turns", s.turns); p.add("added", s.added); p.add("removed", s.removed);
  }
  for (const [sc, pj] of prs.values()) bucket(proj, key(sc, pj)).add("prs");
  out.projects = sorted(proj).map(([k, p]) => {
    const [scope, project] = unkey(k);
    return { scope, project, sessions: p.n("sessions"), prompts: p.n("prompts"), turns: p.n("turns"), cost_usd: r2(p.n("cost")), lines_added: p.n("added"), lines_removed: p.n("removed"), prs: p.n("prs") };
  });

  out.tools = withAll(sorted(tools).filter(([, m]) => m.n("calls")).map(([k, m]) => { const [scope, tool] = unkey(k); return { scope, tool, calls: m.n("calls"), errors: m.n("errors") }; }),
    ["tool"], ["calls", "errors"]);
  out.hours = withAll(sorted(hours).map(([k, n]) => { const [scope, w, h] = unkey(k); return { scope, weekday: Number(w), hour: Number(h), prompts: n }; }), ["weekday", "hour"], ["prompts"]);
  out.guardrails = withAll([
    ...sorted(perms).map(([k, n]) => { const [scope, outcome, reason] = unkey(k); return { scope, kind: "Permission", outcome, reason, count: n }; }),
    ...sorted(apiErr).map(([k, n]) => { const [scope, reason] = unkey(k); return { scope, kind: "API error", outcome: "Failed", reason, count: n }; }),
  ], ["kind", "outcome", "reason"], ["count"]);

  out.kpis = [...SCOPES, "all"].map((sc) => {
    const scs = scopesOf(sc);
    const ss = live.filter((s) => scs.includes(s.scope));
    const inv = [...skillInv.entries()].map(([k, n]) => [...unkey(k), n] as [string, string, string, number]).filter(([x]) => scs.includes(x as Scope));
    const days = new Set([...ss.flatMap((s) => [...s.days]), ...ss.map((s) => localDay(s.start!))]);
    return {
      scope: sc, sessions: ss.length, active_days: days.size, prompts: ss.reduce((a, s) => a + s.prompts, 0), turns: ss.reduce((a, s) => a + s.turns, 0),
      cost_usd: r2(ss.reduce((a, s) => a + s.cost, 0)),
      output_tokens: [...models.entries()].filter(([k]) => scs.includes(unkey(k)[0] as Scope)).reduce((a, [, m]) => a + m.n("output_tokens"), 0),
      skill_invocations: inv.reduce((a, r) => a + r[3], 0), custom_invocations: inv.filter((r) => cat.custom.has(r[1])).reduce((a, r) => a + r[3], 0),
      skills_used: new Set(inv.filter((r) => r[3]).map((r) => r[1])).size, custom_unused: [...cat.custom.keys()].filter((k) => !ran(scs, k)).length,
      subagents: [...agents.entries()].filter(([k]) => scs.includes(unkey(k)[0] as Scope)).reduce((a, [, n]) => a + n, 0),
      workflow_runs: scs.reduce((a, x) => a + workflowTool.n(x), 0), prs: [...prs.values()].filter(([x]) => scs.includes(x)).length,
      lines_added: ss.reduce((a, s) => a + s.added, 0), lines_removed: ss.reduce((a, s) => a + s.removed, 0),
      first_day: ss.length ? localDay(new Date(Math.min(...ss.map((s) => +s.start!)))) : "",
      last_day: ss.length ? localDay(new Date(Math.max(...ss.map((s) => +s.end!)))) : "",
    };
  });
  return out;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { projects: { type: "string" }, out: { type: "string" }, root: { type: "string" } } });
  const projects = resolve(values.projects ?? join(homedir(), ".claude", "projects"));
  const outDir = resolve(values.out ?? join(homedir(), ".claude", "usage-report"));
  const root = resolve(values.root ?? join(import.meta.dir, ".."));
  if (!existsSync(projects)) { console.error(`no transcripts at ${projects}`); process.exit(1); }
  const data = aggregate(projects, loadCatalog(root));
  mkdirSync(outDir, { recursive: true });
  for (const [name, rows] of Object.entries(data)) writeFileSync(join(outDir, name + ".json"), JSON.stringify(rows));
  const k = Object.fromEntries(data.kpis.map((r) => [r.scope, r]));
  console.log(`Wrote ${Object.keys(data).length} datasets to ${outDir}`);
  console.log(`Your sessions: ${k.interactive.sessions}, skill runs: ${k.interactive.skill_invocations}, est. cost: $${k.interactive.cost_usd}. Automated: ${k.automated.sessions} sessions.`);
  console.log("To update the dashboard, ask Claude to refresh it from these files, or replace each file in the dashboard's Sources panel.");
}
