/**
 * Delivery autonomy policy (v3): what the user has approved once, in `.claude/delivery.json`,
 * so Claude doesn't stop to ask for the mechanical steps of shipping a change.
 *
 *   "autonomy": {
 *     "push": ["feature/*"],        // branches Claude may push without asking (never the base branch)
 *     "openPr": true,               // open the pull request after pushing
 *     "autoFix": true,              // turn on PR monitoring / Auto-fix when the host offers it
 *     "cleanupMerged": true,        // after a merge: remove the worktree, delete the local branch
 *     "continue": { "backlog": "TODO.md", "maxItems": 3 },   // then start the next unblocked item
 *     "localClusters": ["kind-*", "minikube"]               // kubectl/helm contexts that need no ask
 *   }
 *
 * Merging, tags, releases, publishing, deploys, pushes to the base branch and force pushes always
 * ask: they are not part of the policy. No `autonomy` key = v2 behaviour (ask before every push).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface Autonomy {
  push: string[];
  openPr: boolean;
  autoFix: boolean;
  cleanupMerged: boolean;
  continue: { backlog: string; maxItems: number } | null;
  localClusters: string[];
  base: string | null;
}

type Any = any;

const read = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } };

/**
 * `.claude/delivery.json` from cwd up to the repository root; in a linked worktree (for example
 * `.claude/worktrees/<branch>`) it falls back to the main checkout's file. {} when missing or invalid.
 */
export function loadConfig(cwd: string): Any {
  for (let dir = cwd; dir && dir !== "/"; dir = join(dir, "..")) {
    const p = join(dir, ".claude", "delivery.json");
    if (existsSync(p)) return read(p);
    if (existsSync(join(dir, ".git"))) break;
  }
  try {
    const out = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd, stdout: "pipe", stderr: "ignore" });
    if (out.exitCode !== 0) return {};
    const common = out.stdout.toString().trim();
    const main = dirname(isAbsolute(common) ? common : resolve(cwd, common));
    const p = join(main, ".claude", "delivery.json");
    return existsSync(p) ? read(p) : {};
  } catch { return {}; }
}

export function parseAutonomy(config: Any): Autonomy | null {
  const a = config?.autonomy;
  if (!a || typeof a !== "object") return null;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s.length > 0) : []);
  const c = a.continue;
  return {
    push: strings(a.push),
    openPr: a.openPr !== false && strings(a.push).length > 0,
    autoFix: a.autoFix === true,
    cleanupMerged: a.cleanupMerged === true,
    continue: c ? { backlog: typeof c.backlog === "string" ? c.backlog : "TODO.md", maxItems: Number.isInteger(c.maxItems) && c.maxItems > 0 ? c.maxItems : 3 } : null,
    localClusters: strings(a.localClusters),
    base: typeof a.base === "string" ? a.base : null,
  };
}

/** Shell-style glob for branch and context names: `*` matches within a path segment, `**` across. */
export function globMatch(glob: string, name: string): boolean {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`).test(name);
}

const BASES = new Set(["main", "master", "trunk", "develop"]);

/** Split a command line into its simple commands (on ; && || | and newlines), ignoring quoted separators. */
export function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "", q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && cmd[i + 1] === "&")) {
      out.push(cur); cur = "";
      if ((ch === "&" || ch === "|") && cmd[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const words = (s: string) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));

/** Drop shell redirections (`2>&1`, `>out.log`, `2> /dev/null`, `&>log`): they aren't command arguments. */
export function withoutRedirects(ws: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const m = /^(?:\d*|&)(?:>>?|<)(.*)$/.exec(ws[i]);
    if (!m) out.push(ws[i]);
    else if (!m[1]) i++; // `2> file`: the target is the next word
  }
  return out;
}

/**
 * Why a `git push` segment falls outside the policy, or null when every branch it updates may be pushed.
 * `current` is the checked-out branch, used when the push names no refspec or uses HEAD.
 */
export function pushOutsidePolicy(segment: string, policy: Autonomy, current: string | null): string | null {
  const w = withoutRedirects(words(segment));
  const at =w.findIndex((x, i) => x === "push" && w.slice(0, i).includes("git"));
  if (at < 0) return null;
  const args = w.slice(at + 1);
  const flags = args.filter((a) => a.startsWith("-"));
  if (flags.some((f) => /^(-f|--force|--force-with-lease|--force-if-includes|--mirror|--all|--tags|--follow-tags|-d|--delete|--prune)(=.*)?$/.test(f) || /^-[a-zA-Z]*f/.test(f))) return "force, delete, tag or all-branch push";
  const pos = args.filter((a) => !a.startsWith("-") && !/^(-o|--push-option|--repo|--receive-pack|--exec)$/.test(a));
  const refspecs = pos.slice(1);
  const targets = (refspecs.length ? refspecs : ["HEAD"]).map((r) => {
    if (r.startsWith("+")) return { forced: true, dst: r.slice(1) };
    if (r.startsWith(":")) return { forced: false, dst: "" };
    const dst = r.includes(":") ? r.split(":").pop()! : r;
    return { forced: false, dst };
  });
  for (const t of targets) {
    if (t.forced) return "force push (+refspec)";
    if (!t.dst) return "branch deletion";
    let dst = t.dst.replace(/^refs\/heads\//, "");
    if (dst === "HEAD" || dst === "@") dst = current ?? "";
    if (!dst || dst.startsWith("refs/") || /^v?\d+\.\d+/.test(dst)) return `push of ${t.dst}`;
    if (BASES.has(dst) || dst === policy.base) return `push to the base branch ${dst}`;
    if (!policy.push.some((g) => globMatch(g, dst))) return `${dst} is not in autonomy.push`;
  }
  return null;
}

/** The kube context a kubectl/helm segment targets: an explicit flag, else null (meaning "current"). */
export function explicitContext(segment: string): string | null {
  const m = /--(?:kube-)?context(?:=|\s+)(\S+)/.exec(segment);
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

/**
 * Standing-authorization text added to the session context when the policy is on.
 * `cleanupScript` is the absolute path of cleanup_merged.ts; without it the cleanup steps are spelled out.
 */
export function policyContext(p: Autonomy, base: string, cleanupScript?: string): string {
  const lines = [
    "Delivery autonomy: the user approved this policy in .claude/delivery.json. It is standing authorization; don't ask again for these steps.",
    `- Ship without stopping to offer it: when the checks pass, commit (Conventional Commits), push branches matching ${p.push.join(", ")}${p.openPr ? `, and open the pull request against ${base} (follow CONTRIBUTING.md or the PR template)` : ""}, in the same turn. Work on a new feature branch, never directly on ${base}.`,
  ];
  if (p.autoFix) lines.push("- After opening a PR, turn on PR monitoring / Auto-fix when the host offers it.");
  if (p.cleanupMerged) lines.push(cleanupScript
    ? `- When the user says a PR is merged (or you see it is): run \`bun "${cleanupScript}" -C <main checkout>\` once and relay its lines. It fetches with prune, fast-forwards ${base}, removes the clean worktrees of merged branches and deletes them with \`git branch -d\`; anything unmerged or dirty is kept with the reason. Don't redo these steps by hand.`
    : `- When the user says a PR is merged (or you see it is): \`git fetch --prune\`, update ${base}, remove that branch's worktree and delete its local branch with \`git branch -d\` (never -D).`);
  if (p.continue) lines.push(`- Then continue: start the next item in ${p.continue.backlog} whose dependencies are done (merged), up to ${p.continue.maxItems} items per request, and ship each the same way. Skip items that need a decision.`);
  if (p.localClusters.length) lines.push(`- kubectl/helm against local clusters (${p.localClusters.join(", ")}) needs no ask.`);
  lines.push(
    `- Still stop and ask, with every open question in one message: merging, tags, releases, publishing, deploys, pushing to ${base}, force pushes, deleting unmerged work, and any item that needs a decision (an ADR, cost, an open question, missing access or credentials).`,
    "- If the user says to hold, wait or not push, hold. When you are blocked on the user, keep doing the unblocked work and ask once at the end.",
  );
  return lines.join("\n");
}
