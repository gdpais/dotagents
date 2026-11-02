#!/usr/bin/env bun
/**
 * Which tool calls stopped for permission, and who stopped them: you, a hook, or auto mode's classifier.
 *
 * Claude Code records a `permissionDecision` on every tool result ({decision, source, reasonType, reasonCode,
 * classifierCategory}) and the stdout of each hook as an attachment. This joins them to the tool call, so
 * "Claude keeps asking" becomes a list: the command, what asked (the delivery guard's reason, a classifier
 * category, a rule), and whether you approved or it was refused. Calls approved without a prompt are only counted.
 *
 * Usage: permission_audit.ts [--projects DIR] [--project TEXT] [--since YYYY-MM-DD] [--json]
 *   --projects  transcripts folder (default ~/.claude/projects)
 *   --project   only project folders whose name contains TEXT (for example Heartbeat)
 *   --since     only calls on or after this date (local time)
 *   --json      one row per stopped call, instead of the text report
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

type Any = any;

export interface Stop {
  time: string;
  project: string;
  session: string;
  subagent: boolean;
  tool: string;
  /** what stopped the call: "you approved", "you declined", "auto mode blocked", "hook blocked", "rule blocked" */
  outcome: string;
  /** why: the hook's reason, the classifier's category or code, or the permission source */
  cause: string;
  input: string;
}

export interface Audit { stops: Stop[]; auto: Record<string, number> }

function jsonlFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsonlFiles(p, out);
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** The part of a tool input worth showing: the command, a URL or path, else the JSON. */
export function summarize(input: Any): string {
  const s = input?.command ?? input?.url ?? input?.file_path ?? input?.skill ?? JSON.stringify(input ?? {});
  return String(s).replace(/\s+/g, " ").trim().slice(0, 240);
}

/** A hook's stdout as a decision and reason, when it made one. */
function hookDecision(stdout: string): { decision: string; reason: string } | null {
  try {
    const h = JSON.parse(stdout)?.hookSpecificOutput;
    return h?.permissionDecision ? { decision: h.permissionDecision, reason: String(h.permissionDecisionReason ?? "") } : null;
  } catch { return null; }
}

/** Short cause label: the delivery guard's reason up to "is outward-facing", a classifier category, or the source. */
export function causeOf(pd: Any, hook: { decision: string; reason: string } | undefined): string {
  if (hook && hook.decision !== "allow") return `hook ${hook.decision}: ${hook.reason.replace(/ is outward-facing.*$/, "").slice(0, 120)}`;
  if (pd.reasonType === "classifier") return `classifier${pd.classifierCategory ? ` [${pd.classifierCategory}]` : ""}${pd.reasonCode && pd.reasonCode !== "classifier:auto-mode" ? ` (${pd.reasonCode})` : ""}`;
  return [pd.reasonType, pd.reasonCode].filter(Boolean).join(" ") || "permission rules";
}

export function outcomeOf(pd: Any): string | null {
  const user = String(pd.source ?? "").startsWith("user");
  if (pd.decision === "accept") return user ? "you approved" : null;
  if (user) return "you declined";
  if (pd.reasonType === "classifier") return "auto mode blocked";
  if (pd.source === "hook") return "hook blocked";
  return "rule blocked";
}

/** Stopped calls in one transcript, plus a count of calls approved without a prompt, by source. */
export function scanTranscript(text: string, meta: { project: string; session: string; subagent: boolean }, since?: string): Audit {
  const uses = new Map<string, { name: string; input: Any }>();
  const hooks = new Map<string, { decision: string; reason: string }>();
  const stops: Stop[] = [];
  const auto: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line.includes("tool_use") && !line.includes("permissionDecision")) continue;
    let e: Any;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (e?.type === "assistant" && Array.isArray(content)) for (const c of content) if (c?.type === "tool_use") uses.set(c.id, { name: c.name, input: c.input });
    const a = e?.attachment;
    if (a?.type?.startsWith("hook") && a.toolUseID && typeof a.stdout === "string") {
      const h = hookDecision(a.stdout);
      if (h) hooks.set(a.toolUseID, h);
    }
    const pd = e?.permissionDecision;
    if (!pd || !Array.isArray(content)) continue;
    if (since && String(e.timestamp ?? "") < since) continue;
    for (const c of content) {
      if (c?.type !== "tool_result") continue;
      const outcome = outcomeOf(pd);
      if (!outcome) { const k = `${pd.source}${pd.reasonType ? `/${pd.reasonType}` : ""}`; auto[k] = (auto[k] ?? 0) + 1; continue; }
      const use = uses.get(c.tool_use_id);
      stops.push({ time: String(e.timestamp ?? ""), ...meta, tool: use?.name ?? "?", outcome, cause: causeOf(pd, hooks.get(c.tool_use_id)), input: summarize(use?.input) });
    }
  }
  return { stops, auto };
}

/** Every transcript under `projectsDir` (sessions and their subagents), optionally one project and a start date. */
export function audit(projectsDir: string, opts: { project?: string; since?: string } = {}): Audit {
  const out: Audit = { stops: [], auto: {} };
  const since = opts.since ? new Date(`${opts.since}T00:00:00`).toISOString() : undefined;
  for (const f of jsonlFiles(projectsDir)) {
    const parts = relative(projectsDir, f).split("/");
    if (opts.project && !parts[0].includes(opts.project)) continue;
    const subagent = parts.includes("subagents") || basename(f).startsWith("agent-");
    const session = subagent && parts.length > 2 ? parts[1] : basename(f, ".jsonl");
    const r = scanTranscript(readFileSync(f, "utf8"), { project: parts[0], session: session.slice(0, 8), subagent }, since);
    out.stops.push(...r.stops);
    for (const [k, n] of Object.entries(r.auto)) out.auto[k] = (out.auto[k] ?? 0) + n;
  }
  out.stops.sort((a, b) => a.time.localeCompare(b.time));
  return out;
}

export function render(a: Audit): string {
  const lines: string[] = [];
  const approved = Object.values(a.auto).reduce((s, n) => s + n, 0);
  lines.push(`${a.stops.length} call(s) stopped for permission; ${approved} approved without a prompt (${Object.entries(a.auto).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}).`);
  const groups = new Map<string, Stop[]>();
  for (const s of a.stops) {
    const k = `${s.outcome} · ${s.cause} · ${s.tool}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  for (const [k, ss] of [...groups.entries()].sort((x, y) => y[1].length - x[1].length)) {
    lines.push("", `${ss.length}× ${k}`);
    for (const s of ss.slice(0, 5)) lines.push(`   ${s.time.slice(0, 16)} ${s.session}${s.subagent ? " (subagent)" : ""}  ${s.input.slice(0, 140)}`);
    if (ss.length > 5) lines.push(`   … ${ss.length - 5} more`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { projects: { type: "string" }, project: { type: "string" }, since: { type: "string" }, json: { type: "boolean" } } });
  const projects = resolve(values.projects ?? join(homedir(), ".claude", "projects"));
  if (!existsSync(projects)) { console.error(`no transcripts at ${projects}`); process.exit(1); }
  if (values.since && !/^\d{4}-\d{2}-\d{2}$/.test(values.since)) { console.error("--since takes YYYY-MM-DD"); process.exit(2); }
  const a = audit(projects, { project: values.project, since: values.since });
  console.log(values.json ? JSON.stringify(a.stops, null, 1) : render(a));
}
