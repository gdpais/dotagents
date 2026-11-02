#!/usr/bin/env bun
/**
 * Merge risk of a pull request or branch: `low`, `medium` or `breaking`, with the reasons, the merge
 * route the project's policy allows, the CI state, and the evidence a person needs to approve it.
 * Run it in the session that reviewed the change (after engineering:code-review), so the risk call and the
 * review verdict come from the same reading of the code.
 *
 * Usage: pr_risk.ts [-C PATH] (--pr N | --base BRANCH) [--review ok|fix|blocking] [--json]
 *   --pr      a GitHub pull request, read with `gh pr view` and `gh pr diff` (never checked out)
 *   --base    the current branch against BRANCH (local git only; CI shows as "none")
 *   --review  the engineering:code-review verdict: blocking (any Critical or High finding), fix (Medium),
 *             ok (Low or none)
 *
 * The level is a floor computed from the diff and commits; the reviewer may raise it, never lower it, and
 * when unsure between medium and breaking, treats it as breaking.
 *   breaking  a breaking-change commit or PR title (`feat!:`, `BREAKING CHANGE:`), a destructive migration,
 *             or a public contract (OpenAPI, proto, GraphQL) that lost lines or was deleted
 *   medium    a required security, migration, performance, CI/infra or dependency gate; a major dependency
 *             bump; size L or XL; a public surface or contract change (with or without docs); source changed
 *             without tests; or a review verdict of `fix`
 *   low       none of these
 * Route, from `autonomy.merge` in .claude/delivery.json, e.g. {"low": "green", "medium": "decide"}:
 *   low: "green" merges on green; medium: "decide" (Claude merges on green, blocks it, or asks with
 *   evidence) or "green"; breaking always waits for the user's review and approval, with evidence. Without
 *   the key, every merge asks. A `blocking` review means fix first, whatever the level. A PR the script
 *   couldn't read whole (over 100 files, or no diff) needs the user too.
 * Read-only. Exit 0; 2 on errors (no gh, unknown PR, not a repository).
 */
import { parseArgs } from "node:util";
import { loadConfig, parseAutonomy, type Autonomy } from "../../../hooks/autonomy";
import { attachAddedLines, classify, classifyRepo, collect, TEST, type FileChange } from "./classify_change";

export type Level = "low" | "medium" | "breaking";
export type Verdict = "ok" | "fix" | "blocking";
export type Ci = "green" | "pending" | "red" | "none";
export interface Risk {
  level: Level;
  reasons: string[];
  route: "merge on green" | "Claude decides: merge on green, block, or ask" | "needs your approval" | "fix first";
  /** true when the policy lets Claude merge without asking (once CI is green) */
  auto: boolean;
  ci: Ci;
  pr: number | null;
  head: string | null;
  draft: boolean;
  /** why the script couldn't read the whole PR, when it couldn't */
  incomplete: string | null;
  evidence: string[];
}

const CONTRACT = /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$|\.proto$|\.graphql$|\.gql$|(^|\/)schema\.graphql$/i;
const BREAKING_COMMIT = /^\w+(\([^)]*\))?!:|^BREAKING[ -]CHANGE:/m;
const PUBLIC = /(^|\/)(api|public|routes?|openapi|proto|graphql|sdk|cli)(\/|\.|$)/i;
// Dependency-update titles from Renovate ("chore(deps): update helm release loki to v20") and Dependabot
// ("Bump lodash from 4.17.21 to 5.0.0").
const DEP_TITLE = /\((?:deps|deps-dev)\)|\b(?:dependency|dependencies|docker tag|helm release|module|action|digest)\b|^bump\b/i;
const UI = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$|(^|\/)(web|ui|frontend|components|pages|screens|views)\//i;
const MOBILE = /\.(swift|kt|kts|dart)$|(^|\/)(ios|android)\//i;
const SERVICE = /(^|\/)(api|routes?|handlers?|server|controllers?|services?)\/|(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$|\.proto$/i;
const DEPLOY = /(^|\/)(helm|charts|k8s|kubernetes|manifests|terraform)\/|(^|\/)Dockerfile[^/]*$|\.tf$/i;
const CLI = /(^|\/)(cli|bin|cmd)\//i;

type Classification = ReturnType<typeof classify>;

/** The risk floor and why, from the classified diff, the per-file counts, the commit messages and PR title. */
export function assess(c: Classification, files: FileChange[], messages: string[], review?: Verdict): { level: Level; reasons: string[] } {
  const breaking: string[] = [], medium: string[] = [];
  const marked = messages.find((m) => BREAKING_COMMIT.test(m));
  if (marked) breaking.push(`breaking-change commit: ${marked.split("\n")[0].slice(0, 80)}`);
  for (const s of c.gates.migrations.signals) if (s.signal === "destructive schema change") breaking.push(`destructive migration (${s.file}${s.line ? `:${s.line}` : ""})`);
  for (const f of files.filter((x) => CONTRACT.test(x.path) && !TEST.test(x.path))) {
    if (f.deleted > f.added) breaking.push(`public contract lost lines: ${f.path} (+${f.added}/-${f.deleted})`);
    else medium.push(`public contract changed: ${f.path}`);
  }
  const gate = (name: keyof Classification["gates"], label: string) => {
    const g = c.gates[name];
    if (g.level === "required") medium.push(`${label}: ${g.signals.slice(0, 2).map((s) => `${s.signal}${s.file ? ` (${s.file}${s.line ? `:${s.line}` : ""})` : ""}`).join("; ")}`);
  };
  gate("security", "security gate");
  gate("migrations", "migration");
  gate("performance", "performance gate");
  gate("infra", "CI/infra change");
  gate("dependencies", "dependency change");
  if (messages.map((m) => m.split("\n")[0]).find(majorBump)) medium.push(`major version bump: ${messages.map((m) => m.split("\n")[0]).find(majorBump)!.slice(0, 80)}`);
  if (c.size === "L" || c.size === "XL") medium.push(`size ${c.size} (+${c.totals.added}/-${c.totals.deleted})`);
  const surface = c.changed.filter((f) => PUBLIC.test(f) && !TEST.test(f));
  if (surface.length) medium.push(`public surface changed: ${surface.slice(0, 3).join(", ")}`);
  if (c.gates.tests.level === "required") medium.push(`source changed without tests: ${c.gates.tests.signals.slice(0, 3).map((s) => s.file).join(", ")}`);
  if (review === "fix") medium.push("review found P2 issues");
  const level: Level = breaking.length ? "breaking" : medium.length ? "medium" : "low";
  return { level, reasons: breaking.length ? breaking : medium.length ? [...new Set(medium)] : ["no risk signal: small change, tests alongside, no sensitive paths"] };
}

/** A dependency update that crosses a major version: "to v2" (Renovate) or "from 4.x to 5.0" (Dependabot). */
export function majorBump(title: string): boolean {
  if (!DEP_TITLE.test(title)) return false;
  const fromTo = /\bfrom v?(\d+)[\w.+-]*\s+to v?(\d+)/i.exec(title);
  if (fromTo) return Number(fromTo[2]) > Number(fromTo[1]);
  return /\bto v?\d+\s*(?:$|\(|\[)/i.test(title);
}

/** What the policy lets Claude do with a PR of this level. */
export function routeFor(level: Level, merge: Autonomy["merge"] | null, review?: Verdict): Pick<Risk, "route" | "auto"> {
  if (review === "blocking") return { route: "fix first", auto: false };
  if (level === "low" && merge?.low === "green") return { route: "merge on green", auto: true };
  if (level === "medium" && merge?.medium === "green") return { route: "merge on green", auto: true };
  if (level === "medium" && merge?.medium === "decide") return { route: "Claude decides: merge on green, block, or ask", auto: true };
  return { route: "needs your approval", auto: false };
}

/** CI from `gh pr view --json statusCheckRollup`: check runs and commit statuses. */
export function ciState(rollup: { status?: string; conclusion?: string; state?: string }[] | undefined): Ci {
  if (!rollup?.length) return "none";
  let pending = false;
  for (const r of rollup) {
    const v = (r.conclusion || r.state || "").toUpperCase();
    if (/FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE/.test(v)) return "red";
    if ((r.status && r.status.toUpperCase() !== "COMPLETED") || /PENDING|EXPECTED|QUEUED|IN_PROGRESS/.test(v) || !v) pending = true;
  }
  return pending ? "pending" : "green";
}

/**
 * The evidence an approval needs, facing the product and adapted to what the change touches: what a user
 * would see (screenshots, a recording, a live demo, a cluster run), backed by well-defined test results.
 * Low risk needs only test results and CI. The project adds its own items (`evidence` in .claude/delivery.json).
 */
export function evidenceFor(changed: string[], level: Level, extra: string[] = []): string[] {
  const code = changed.filter((f) => !TEST.test(f));
  const tests = [
    "Test results: the commands run, exit codes and pass/fail counts; name the tests that cover the feature and show the new ones fail without the change.",
    "CI on the head commit: green, with a link to the run.",
  ];
  if (level === "low") return tests;
  const product: string[] = [];
  if (code.some((f) => UI.test(f))) product.push("Screenshots of each changed screen, before and after.", "A short screen recording (GIF or video) of the feature being used end to end.");
  if (code.some((f) => MOBILE.test(f))) product.push("Simulator screenshots of the changed screens, and a recording of the flow.");
  if (code.some((f) => SERVICE.test(f))) product.push("Live demo against a running instance: the requests a client sends and what comes back, working and failing safely.");
  if (code.some((f) => DEPLOY.test(f))) product.push("A run on a local cluster (kind or minikube) showing the product working with the change: commands and output.");
  if (code.some((f) => CLI.test(f) && !SERVICE.test(f))) product.push("A command transcript showing the new behaviour as a user runs it.");
  if (!product.length) product.push("A demo of the feature from the user's side: what they do and what they see (screenshot, recording or transcript).");
  if (level === "breaking") product.push("Upgrade path: what users, callers or operators must change, and how to roll back.");
  return [...product, ...tests, ...extra];
}

const run = (cmd: string[], cwd: string, timeout: number) => {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout });
    return p.exitCode === 0 ? p.stdout.toString() : null;
  } catch { return null; }
};

/** Read a PR (with gh) or the current branch against a base, and assess it. Returns an error string on failure. */
export async function prRisk(cwd: string, target: { pr?: number; base?: string }, review?: Verdict, timeoutMs = 40_000): Promise<Risk | string> {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const config = loadConfig(cwd);
  const merge = parseAutonomy(config)?.merge ?? null;
  const extra = Array.isArray(config.evidence) ? config.evidence.filter((s: unknown): s is string => typeof s === "string") : [];
  let c: Classification, files: FileChange[], messages: string[], ci: Ci = "none", head: string | null = null, draft = false, incomplete: string | null = null;
  if (target.pr !== undefined) {
    const raw = run(["gh", "pr", "view", String(target.pr), "--json", "title,headRefOid,isDraft,files,changedFiles,commits,statusCheckRollup"], cwd, left());
    if (!raw) return `gh pr view ${target.pr} failed (is gh installed and signed in, and does the PR exist?)`;
    const v = JSON.parse(raw);
    const map = new Map<string, FileChange>((v.files ?? []).map((f: { path: string; additions: number; deletions: number }) =>
      [f.path, { path: f.path, added: f.additions, deleted: f.deletions, binary: false, addedLines: [] }]));
    const patch = run(["gh", "pr", "diff", String(target.pr)], cwd, left());
    if (patch === null) incomplete = "couldn't read the PR's diff";
    else if ((v.changedFiles ?? 0) > map.size) incomplete = `the PR changes ${v.changedFiles} files and only ${map.size} could be read`;
    attachAddedLines(patch ?? "", map);
    files = [...map.values()];
    c = classify(files, config);
    messages = [v.title ?? "", ...(v.commits ?? []).map((m: { messageHeadline?: string; messageBody?: string }) => `${m.messageHeadline ?? ""}\n\n${m.messageBody ?? ""}`)];
    ci = ciState(v.statusCheckRollup);
    head = v.headRefOid ?? null;
    draft = !!v.isDraft;
  } else {
    const r = await classifyRepo(cwd, { base: target.base ?? "main" });
    if (typeof r === "string") return r;
    const collected = await collect(cwd, r.diffArgs, false);
    files = typeof collected === "string" ? [] : collected;
    c = r;
    messages = (run(["git", "log", "--format=%B%x00", `${r.target.merge_base}..HEAD`], cwd, left()) ?? "").split("\0").map((s) => s.trim()).filter(Boolean);
    head = run(["git", "rev-parse", "HEAD"], cwd, left())?.trim() ?? null;
  }
  const assessed = assess(c, files, messages, review);
  // Partial data can hide a breaking signal: rate it at least medium, and it needs the user.
  const level: Level = incomplete && assessed.level === "low" ? "medium" : assessed.level;
  const reasons = incomplete ? [`incomplete: ${incomplete}`, ...assessed.reasons.filter((x) => !x.startsWith("no risk signal"))] : assessed.reasons;
  const route = incomplete ? { route: "needs your approval" as const, auto: false } : routeFor(level, merge, review);
  return { level, reasons, ...route, ci, pr: target.pr ?? null, head, draft, incomplete, evidence: evidenceFor(c.changed, level, extra) };
}

export function render(r: Risk): string {
  const lines = [`risk: ${r.level} · route: ${r.route} · CI: ${r.ci}${r.draft ? " · draft" : ""}${r.pr !== null ? ` · PR #${r.pr}` : ""}${r.head ? ` (head ${r.head.slice(0, 7)})` : ""}`];
  if (r.level === "breaking") lines.push("  never merge it yourself: wait for the user's review and approval");
  for (const why of r.reasons) lines.push(`  - ${why}`);
  lines.push(r.auto ? "evidence (summarise in the PR; give it in full if you ask instead of merging):" : "evidence for the approval request (product-facing):");
  for (const e of r.evidence) lines.push(`  - ${e}`);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { C: { type: "string", short: "C" }, pr: { type: "string" }, base: { type: "string" }, review: { type: "string" }, json: { type: "boolean" } } });
  if (!values.pr === !values.base) { console.error("usage: pr_risk.ts [-C PATH] (--pr N | --base BRANCH) [--review ok|fix|blocking] [--json]"); return 2; }
  if (values.review && !["ok", "fix", "blocking"].includes(values.review)) { console.error("--review takes ok, fix or blocking"); return 2; }
  const r = await prRisk(values.C ?? process.cwd(), values.pr ? { pr: Number(values.pr.replace(/^#/, "")) } : { base: values.base }, values.review as Verdict | undefined);
  if (typeof r === "string") { console.error(r); return 2; }
  console.log(values.json ? JSON.stringify(r, null, 2) : render(r));
  return 0;
}

if (import.meta.main) process.exit(await main());
