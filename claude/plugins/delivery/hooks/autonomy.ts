/**
 * Delivery autonomy policy (v3): what the user has approved once, in `.claude/delivery.json`,
 * so Claude doesn't stop to ask for the mechanical steps of shipping a change.
 *
 *   "autonomy": {
 *     "push": ["feature/*"],        // branches Claude may push without asking (never the base branch)
 *     "openPr": true,               // open the pull request after pushing
 *     "autoFix": true,              // turn on PR monitoring / Auto-fix when the host offers it
 *     "cleanupMerged": true,        // after a merge: remove the worktree, delete the local branch
 *     "continue": { "backlog": "TODO.md" },                  // then start the next unblocked item, until none is left
 *     "localClusters": ["kind-*", "minikube"],              // kubectl/helm contexts that need no ask
 *     "workflows": ["scenarios.yml"],                       // `gh workflow run` targets that need no ask
 *     "merge": { "low": "green", "medium": "decide" },     // merge by risk (pr_risk.ts); breaking never
 *     "review": true                // engineering:code-review before pushing (default; false turns it off)
 *   }
 *
 * Merging, tags, releases, publishing, deploys, pushes to the base branch and force pushes always
 * ask: they are not part of the policy. A merge the user's own last message asked for (by PR number)
 * isn't asked again. No `autonomy` key = v2 behaviour (ask before every push).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface Autonomy {
  push: string[];
  openPr: boolean;
  autoFix: boolean;
  cleanupMerged: boolean;
  continue: { backlog: string } | null;
  localClusters: string[];
  workflows: string[];
  review: boolean;
  /** merge without asking, by risk level (pr_risk.ts); breaking changes always ask */
  merge: { low: "green" | "ask"; medium: "green" | "decide" | "ask" };
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
    continue: c ? { backlog: typeof c.backlog === "string" ? c.backlog : "TODO.md" } : null,
    localClusters: strings(a.localClusters),
    workflows: strings(a.workflows),
    review: a.review !== false,
    merge: { low: a.merge?.low === "green" ? "green" : "ask", medium: a.merge?.medium === "green" || a.merge?.medium === "decide" ? a.merge.medium : "ask" },
    base: typeof a.base === "string" ? a.base : null,
  };
}

/** Tool uses recorded in the session transcript (JSONL). */
export function toolUses(transcript: string): { name: string; input: Any }[] {
  const out: { name: string; input: Any }[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.includes("tool_use")) continue;
    try {
      const content = JSON.parse(line)?.message?.content;
      if (Array.isArray(content)) for (const c of content) if (c?.type === "tool_use") out.push({ name: c.name, input: c.input ?? {} });
    } catch { /* partial line */ }
  }
  return out;
}

/** True when the session loaded the skill (Skill tool, possibly plugin-namespaced) or read its SKILL.md. */
export function skillUsed(uses: { name: string; input: Any }[], skill: string): boolean {
  const bare = skill.split(":").pop()!;
  return uses.some((u) =>
    (u.name === "Skill" && (String(u.input.skill ?? "") === skill || String(u.input.skill ?? "").split(":").pop() === bare)) ||
    (u.name === "Read" && String(u.input.file_path ?? "").endsWith(`/${bare}/SKILL.md`)));
}

/** The reviewer the delivery flow uses (DL-78). */
export const REVIEWER = "engineering:code-review";

/** One review: the reviewer skill loaded, or a subagent briefed to run it (not one told to avoid it). */
const isReview = (u: { name: string; input: Any }) =>
  (u.name === "Skill" && String(u.input.skill ?? "") === REVIEWER) ||
  ((u.name === "Agent" || u.name === "Task") && /engineering:code-review/.test(String(u.input.prompt ?? "")) && !/\b(?:don'?t|do not|never|not|instead of|without)\b[^.\n]{0,40}engineering:code-review/i.test(String(u.input.prompt ?? "")));

/** True when the session ran the reviewer, itself or by handing it to a subagent. */
export function reviewed(uses: { name: string; input: Any }[]): boolean {
  return uses.some(isReview);
}

/** A direct run of pr_risk.ts for PR `n` (not an `echo` or a mention), with its `--review` verdict when given. */
export function riskRun(cmd: string, n?: number): { pr: number; review: string | null } | null {
  const m = /^(?:cd\s+\S+\s*&&\s*)?bun\s+(?:"[^"]*pr_risk\.ts"|\S*pr_risk\.ts)\b([^;&|\n]*)$/.exec(cmd.trim());
  const pr = m && /\s--pr[ =]#?(\d+)\b/.exec(m[1]);
  if (!pr || (n !== undefined && Number(pr[1]) !== n)) return null;
  return { pr: Number(pr[1]), review: /\s--review[ =](ok|fix|blocking)\b/.exec(m[1])?.[1] ?? null };
}

/**
 * The review verdict the session recorded for PR `n` when it reviewed and then assessed it with pr_risk.ts, or
 * null. The review must come before that pr_risk run with no other PR's assessment in between, so in a session
 * with several PRs each review counts for the next PR assessed only. The latest assessment wins.
 */
export function assessedPr(uses: { name: string; input: Any }[], n: number): string | null {
  let review = false, verdict: string | null = null;
  for (const u of uses) {
    if (isReview(u)) { review = true; continue; }
    const r = u.name === "Bash" ? riskRun(String(u.input.command ?? "")) : null;
    if (!r) continue;
    if (r.pr === n) verdict = review && r.review ? r.review : null;
    review = false;
  }
  return verdict;
}

/**
 * The text of the last prompt the user typed: not tool results, hook feedback, a subagent's brief, a message
 * from another session (`origin.kind: "peer"`) or a task notification (`promptSource: "system"`).
 */
export function lastUserPrompt(transcript: string): string {
  let last = "";
  for (const line of transcript.split("\n")) {
    if (!line.includes('"user"')) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type !== "user" || e.isMeta || e.isSidechain) continue;
      if ((e.origin?.kind && e.origin.kind !== "human") || e.promptSource === "system" || ["peer", "task_notification"].includes(e.turnOrigin)) continue;
      const c = e.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x: Any) => x?.type === "text").map((x: Any) => x.text).join(" ") : "";
      if (text && !text.includes("Stop hook feedback") && !text.startsWith("<")) last = text;
    } catch { /* partial line */ }
  }
  return last;
}

/** True when the user asked Claude not to ship yet ("don't push", "hold", "I want to look first"…). */
export function asksToHold(prompt: string): boolean {
  return /\b(don'?t|do not|never|no need to)\b[^.!?\n]{0,30}\b(push|pr|pull request|ship|commit)/i.test(prompt)
    || /\bnot yet\b|\bhold (off|on|it)?\b|\blocal(ly)? only\b|\bkeep it local\b|\b(look|review|check)\b[^.!?\n]{0,25}\bfirst\b/i.test(prompt);
}

const FILLER = new Set(["all", "the", "these", "those", "them", "both", "in", "your", "my", "this", "that", "order", "now", "please", "prs", "pr", "pull", "requests", "request", "and", "&",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);

/**
 * Pull requests the user's own prompt tells Claude to merge, so the guard doesn't ask a second time. Only the PR
 * references right after a merge verb count ("Yes, merge all six in your order: #60, #61, then fix #62" → 60, 61),
 * up to the first other word. Questions ("Is #60 ready to merge?"), "don't merge", a hold, and bystander numbers
 * ("merge #60, it fixes #12" → 60) don't.
 */
export function approvedMerges(prompt: string): Set<number> {
  const out = new Set<number>();
  if (asksToHold(prompt)) return out;
  for (const sentence of prompt.split(/(?<=[.!?])\s+|\n+/)) {
    if (/\?\s*$/.test(sentence) || /\b(?:don'?t|do not|never|not|no need to|wait to|hold off)\b[^.!?\n]{0,30}\bmerg/i.test(sentence)) continue;
    for (const m of sentence.matchAll(/\bmerg(?:e|ing)\b/gi)) {
      const toks = sentence.slice(m.index! + m[0].length).match(/https?:\/\/\S+\/pull\/\d+|#\d+|\bPRs?\s*#?\d+|[\w'&]+|[,:]/gi) ?? [];
      // "fix #62's conflict and merge it": "it" is the nearest PR named before the verb.
      if (toks[0]?.toLowerCase() === "it") {
        const before = [...sentence.slice(0, m.index).matchAll(/(?:\/pull\/|#|\bPRs?\s*#?)(\d+)\b/gi)].pop();
        if (before) out.add(Number(before[1]));
        continue;
      }
      for (const t of toks) {
        const ref = /(?:\/pull\/|#|^PRs?\s*#?)(\d+)$/i.exec(t);
        if (ref) { out.add(Number(ref[1])); continue; }
        if (t === "," || t === ":" || FILLER.has(t.toLowerCase())) continue;
        break;
      }
    }
  }
  return out;
}

/** Shell-style glob for branch and context names: `*` matches within a path segment, `**` across. */
export function globMatch(glob: string, name: string): boolean {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`).test(name);
}

const BASES = new Set(["main", "master", "trunk", "develop"]);

/**
 * Split a command line into its simple commands (on ; && || | & and newlines), ignoring quoted separators. A
 * backslash escapes the next character outside single quotes, as in the shell, so `echo \"; curl x` is two
 * commands; `2>&1` and `&>file` are redirects, not separators.
 */
export function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "", q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "\\" && q !== "'" && i + 1 < cmd.length) { cur += ch + cmd[++i]; continue; }
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    const redirect = ch === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">");
    if (ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && !redirect)) {
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
 * `current` is the checked-out branch, used when the push names no refspec or uses HEAD. `ownRemote` says
 * whether the remote it names (a remote name or URL) is this repository's own; another one isn't covered.
 * A push the parser can't read (`bash -c "git push …"`, `(git push …)`) isn't covered either.
 */
export function pushOutsidePolicy(segment: string, policy: Autonomy, current: string | null, ownRemote: (r: string) => boolean = () => true): string | null {
  const w = withoutRedirects(words(segment));
  const at = w.findIndex((x, i) => x === "push" && w[0] === "git" && w.slice(1, i).every((y, j, a) => y.startsWith("-") || /^-[Cc]$/.test(a[j - 1] ?? "")));
  if (at < 0) return "a push the guard can't read";
  if (w.slice(1, at).includes("-c")) return "push with `-c` config overrides";
  const args = w.slice(at + 1);
  const flags = args.filter((a) => a.startsWith("-"));
  if (flags.some((f) => /^(-f|--force|--force-with-lease|--force-if-includes|--mirror|--all|--tags|--follow-tags|-d|--delete|--prune)(=.*)?$/.test(f) || /^-[a-zA-Z]*f/.test(f))) return "force, delete, tag or all-branch push";
  if (flags.some((f) => /^(--receive-pack|--exec|--repo)(=.*)?$/.test(f))) return "push with a custom remote or remote program";
  const pos = args.filter((a) => !a.startsWith("-") && !/^(-o|--push-option)$/.test(a));
  if (pos[0] && !ownRemote(pos[0])) return `push to ${pos[0]}, not this repository's remote`;
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
 * `riskScript` is the absolute path of pr_risk.ts, used by the merge rules.
 */
export function policyContext(p: Autonomy, base: string, cleanupScript?: string, riskScript = "pr_risk.ts"): string {
  const lines = [
    "Delivery autonomy: the user approved this policy in .claude/delivery.json. It is standing authorization; don't ask again for these steps.",
    `- Ship without stopping to offer it: when the checks pass, ${p.review ? `review the change with the \`engineering:code-review\` skill against ${base} (fix Critical and High findings first; list Medium and Low ones in the PR description), then ` : ""}commit (Conventional Commits), push branches matching ${p.push.join(", ")}${p.openPr ? `, and open the pull request against ${base} (follow CONTRIBUTING.md or the PR template)` : ""}, in the same turn. Work on a new feature branch, never directly on ${base}.`,
  ];
  if (p.autoFix) lines.push("- After opening a PR, turn on PR monitoring / Auto-fix when the host offers it.");
  if (p.cleanupMerged) lines.push(cleanupScript
    ? `- When the user says a PR is merged (or you see it is): run \`bun "${cleanupScript}" -C <main checkout>\` once and relay its lines. It fetches with prune, fast-forwards ${base}, removes the clean worktrees of merged branches and deletes them with \`git branch -d\`; anything unmerged or dirty is kept with the reason. Don't redo these steps by hand.`
    : `- When the user says a PR is merged (or you see it is): \`git fetch --prune\`, update ${base}, remove that branch's worktree and delete its local branch with \`git branch -d\` (never -D).`);
  if (p.continue) lines.push(`- Then continue: start the next item in ${p.continue.backlog} whose dependencies are done (merged), and ship each the same way, until no unblocked item is left. Skip items that need a decision.`);
  if (p.localClusters.length) lines.push(`- kubectl/helm against local clusters (${p.localClusters.join(", ")}) needs no ask.`);
  if (p.workflows.length) lines.push(`- \`gh workflow run\` for ${p.workflows.join(", ")} needs no ask.`);
  const merges = p.merge.low !== "ask" || p.merge.medium !== "ask";
  if (merges) lines.push(
    `- Merging by risk: in the session that reviews a PR with \`engineering:code-review\`, also run \`bun "${riskScript}" -C <repo> --pr <n> --review ok|fix|blocking\` (blocking: any Critical or High finding; fix: Medium; ok: Low or none). It rates the PR low, medium or breaking from the diff. Raise the level when the review shows more risk, never lower it, and when unsure between medium and breaking, treat it as breaking.`,
    `  low: ${p.merge.low === "green" ? "merge on green" : "ask the user"}. medium: ${p.merge.medium === "decide" ? "your call, one of three: merge on green when the review is ok and the evidence shows the feature working; block it (don't merge; fix it, or say why it can't merge) when the review found Critical or High issues or the change isn't right yet; or ask the user, with evidence that the feature works and why it should merge" : p.merge.medium === "green" ? "merge on green" : "ask the user, with evidence"}. breaking: never merge it yourself; wait for the user's review and approval, and always give evidence that the feature works. Never merge on red CI.`,
    "  Evidence faces the product and fits the project: screenshots of the UI, a recording of the feature in use, a live demo of the service (the requests and what comes back), a run on a local cluster, plus well-defined test results (commands, exit codes, counts, which tests cover the feature). The script lists what fits the diff. Put it in the PR and in the ask. With several PRs or sessions waiting, ask once for all of them.",
    "  After a merge, clean up (below) and bring the dependent branches up to date with the base before their own review.",
  );
  lines.push(
    `- Still stop and ask, with every open question in one message: merging${merges ? " beyond the risk rules above" : ""} (unless the user's message just asked you to merge that PR), tags, releases, publishing, deploys, pushing to ${base}, force pushes, deleting unmerged work, and any item that needs a decision (an ADR, cost, an open question, missing access or credentials).`,
    "- If the user says to hold, wait or not push, hold. When you are blocked on the user, keep doing the unblocked work and ask once at the end.",
  );
  return lines.join("\n");
}
