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
 *     "merge": { "low": "green", "medium": "decide", "method": "merge" },  // merge by risk (pr_risk.ts); breaking never
 *     "review": "session",          // engineering:code-review: "session" (a review session per PR, which owns its
 *                                   // merge), true (this session, before pushing; the default) or false (none)
 *     "reviewPreset": "Heartbeat"   // optional desktop-app preset for review sessions
 *   }
 *
 * Merging, tags, releases, publishing, deploys, pushes to the base branch and force pushes always
 * ask: they are not part of the policy. A merge the user's own last message asked for (by PR number)
 * isn't asked again. No `autonomy` key = v2 behaviour (ask before every push).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface Autonomy {
  push: string[];
  openPr: boolean;
  autoFix: boolean;
  cleanupMerged: boolean;
  continue: { backlog: string } | null;
  localClusters: string[];
  workflows: string[];
  /** who runs engineering:code-review: this session before pushing ("self"), a review session per PR, or nobody */
  review: "self" | "session" | false;
  /** desktop-app session preset for review sessions */
  reviewPreset: string | null;
  /** merge without asking, by risk level (pr_risk.ts); breaking changes always ask */
  merge: { low: "green" | "ask"; medium: "green" | "decide" | "ask"; method: "merge" | "squash" | "rebase" };
  base: string | null;
}

export interface ToolUse { name: string; input: Any; id?: string }

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
    review: a.review === false ? false : a.review === "session" ? "session" : "self",
    reviewPreset: typeof a.reviewPreset === "string" && a.reviewPreset ? a.reviewPreset : null,
    merge: {
      low: a.merge?.low === "green" ? "green" : "ask",
      medium: a.merge?.medium === "green" || a.merge?.medium === "decide" ? a.merge.medium : "ask",
      method: ["merge", "squash", "rebase"].includes(a.merge?.method) ? a.merge.method : "merge",
    },
    base: typeof a.base === "string" ? a.base : null,
  };
}

/**
 * The assistant's own entries in a session transcript (JSONL), in order: tool calls and reply text. Other entry
 * types are skipped, and a tool call is counted once: transcripts now also store API request blobs that replay
 * earlier tool calls, and reading those as new calls made the merge guard drop the review (3.2.2, DL-82).
 */
export function assistantEntries(transcript: string): ({ kind: "use" } & ToolUse | { kind: "text"; text: string })[] {
  const out: ({ kind: "use" } & ToolUse | { kind: "text"; text: string })[] = [];
  const seen = new Set<string>();
  for (const line of transcript.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
      for (const c of e.message.content) {
        if (c?.type === "text" && typeof c.text === "string") out.push({ kind: "text", text: c.text });
        if (c?.type !== "tool_use") continue;
        if (c.id) { if (seen.has(c.id)) continue; seen.add(c.id); }
        out.push({ kind: "use", name: c.name, input: c.input ?? {}, ...(c.id ? { id: c.id } : {}) });
      }
    } catch { /* partial line */ }
  }
  return out;
}

/** `p` with symlinks resolved (macOS: /var is /private/var), through its nearest existing parent when it doesn't exist. */
export function realPath(p: string): string {
  try { return realpathSync(p); } catch {
    const up = dirname(p);
    return up === p ? p : join(realPath(up), basename(p));
  }
}

/** Tool uses recorded in the session transcript (JSONL), each once. */
export function toolUses(transcript: string): ToolUse[] {
  return assistantEntries(transcript).flatMap((e) => (e.kind === "use" ? [{ name: e.name, input: e.input, ...(e.id ? { id: e.id } : {}) }] : []));
}

/** True when the session loaded the skill (Skill tool, possibly plugin-namespaced) or read its SKILL.md. */
export function skillUsed(uses: ToolUse[], skill: string): boolean {
  const bare = skill.split(":").pop()!;
  return uses.some((u) =>
    (u.name === "Skill" && (String(u.input.skill ?? "") === skill || String(u.input.skill ?? "").split(":").pop() === bare)) ||
    (u.name === "Read" && String(u.input.file_path ?? "").endsWith(`/${bare}/SKILL.md`)));
}

/** The reviewer the delivery flow uses (DL-78). */
export const REVIEWER = "engineering:code-review";

/** One review: the reviewer skill loaded, or a subagent briefed to run it (not one told to avoid it). */
export const isReview = (u: ToolUse) =>
  (u.name === "Skill" && String(u.input.skill ?? "") === REVIEWER) ||
  ((u.name === "Agent" || u.name === "Task") && /engineering:code-review/.test(String(u.input.prompt ?? "")) && !/\b(?:don'?t|do not|never|not|instead of|without)\b[^.\n]{0,40}engineering:code-review/i.test(String(u.input.prompt ?? "")));

/** True when the session ran the reviewer, itself or by handing it to a subagent. */
export function reviewed(uses: ToolUse[]): boolean {
  return uses.some(isReview);
}

/**
 * True when a reply shows engineering:code-review's own output: one of its findings tables (a header row with
 * File and Line columns) or its Critical Issues and Verdict sections, as opposed to a prose summary.
 */
export function showsReview(text: string): boolean {
  return /^[ \t]*\|[^\n]*\bFile\b[^\n]*\bLine\b[^\n]*\|[ \t]*$/im.test(text) || (/\bCritical Issues\b/i.test(text) && /\bVerdict\b/i.test(text));
}

/**
 * Reviews (by tool-call id, else position) that no later reply shows: the user wants the skill's findings tables in
 * the reply, not a summary (2026-11-04: none of 18 review turns in Heartbeat showed them). A review a subagent ran
 * counts too, since its output reaches only this session.
 */
export function unshownReviews(entries: ReturnType<typeof assistantEntries>): string[] {
  const out: string[] = [];
  let use = 0;
  entries.forEach((e, i) => {
    if (e.kind !== "use") return;
    use++;
    if (isReview(e) && !entries.slice(i + 1).some((x) => x.kind === "text" && showsReview(x.text))) out.push(e.id ?? `#${use}`);
  });
  return out;
}

/**
 * A direct run of pr_risk.ts for PR `n` (not an `echo` or a mention), with its `--review` verdict when given.
 * The run is one simple command of the line, so `cd <repo> && bun pr_risk.ts … 2>&1 | tail -25; gh pr view <n>`
 * counts: before 3.2.2 only a bare run did, and none of the 12 runs in Heartbeat (27 Oct–4 Nov) was bare, so
 * no merge was ever covered. The guard recomputes the risk from the PR, so the line can't lower it.
 */
export function riskRun(cmd: string, n?: number): { pr: number; review: string | null } | null {
  for (const seg of segments(cmd)) {
    const m = /^bun\s+(?:"[^"]*pr_risk\.ts"|'[^']*pr_risk\.ts'|\S*pr_risk\.ts)(?=\s|$)(.*)$/s.exec(seg);
    const args = m && ` ${withoutRedirects(shellWords(m[1])).join(" ")}`;
    const pr = args && /\s--pr[ =]#?(\d+)\b/.exec(args);
    if (!pr) continue;
    if (n !== undefined && Number(pr[1]) !== n) return null;
    return { pr: Number(pr[1]), review: /\s--review[ =](ok|fix|blocking)\b/.exec(args)?.[1] ?? null };
  }
  return null;
}

/**
 * The review verdict the session recorded for PR `n` when it reviewed and then assessed it with pr_risk.ts, or
 * null. A review counts for the next PR assessed after it, so in a session with several PRs each review covers one
 * PR; once it does, later assessments of that PR keep it (re-rating after the fixes land or CI finishes), and the
 * latest assessment's verdict wins.
 */
export function assessedPr(uses: ToolUse[], n: number): string | null {
  let pending = false, verdict: string | null = null;
  const covered = new Set<number>();
  for (const u of uses) {
    if (isReview(u)) { pending = true; continue; }
    const r = u.name === "Bash" ? riskRun(String(u.input.command ?? "")) : null;
    if (!r) continue;
    if (pending) covered.add(r.pr);
    pending = false;
    if (r.pr === n) verdict = covered.has(n) && r.review ? r.review : null;
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

/**
 * A simple command split into words the way the shell does: quotes anywhere in a word, backslash escapes, so
 * `credential.helper='!gh auth git-credential'` is one word. No expansion; an open quote runs to the end.
 */
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = "", word = false, q: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === "\\" && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) cur += s[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; word = true; continue; }
    if (ch === "\\" && i + 1 < s.length) { cur += s[++i]; word = true; continue; }
    if (/\s/.test(ch)) { if (word) out.push(cur); cur = ""; word = false; continue; }
    cur += ch; word = true;
  }
  if (word) out.push(cur);
  return out;
}

/**
 * The command a segment of a compound command runs: `then git push …` (from `if …; then git push …; fi`),
 * `(git push … 2>&1` and `… 2>&1)` from a subshell, `! git ls-remote …`. For reading what runs, not for approving it.
 */
export function compoundBody(seg: string): string {
  return seg.replace(/^(?:(?:if|then|else|elif|do|while|until|!|\{)\s+|\(\s*)+/, "").replace(/(?:\s*[)}])+\s*$/, "");
}

/** `timeout [options] DURATION command…` runs the command with a time limit; the command is what counts. */
export function unwrapTimeout(seg: string): string {
  const m = /^timeout\s+(?:(?:-[ks]\s+\S+|--(?:kill-after|signal)=\S+|--preserve-status|--foreground|-v|--verbose)\s+)*\d+(?:\.\d+)?[smhd]?\s+(\S.*)$/s.exec(seg.trim());
  return m ? m[1] : seg;
}

/**
 * Variables the command line sets to a literal and can't change otherwise (`B=feature/x; git push -u origin "$B"`),
 * for reading outward commands. A name that is assigned twice, assigned something else, or appears bare anywhere
 * else (`read B`, `for B in …`, `export B`) stays unexpanded, and `source`, `.` or `eval` drop them all.
 */
export function literalVars(segs: string[]): Map<string, string> {
  const vals = new Map<string, string | null>();
  const literal = /^([A-Za-z_]\w*)=(?:"([^"$`\\]*)"|'([^']*)'|([^\s"'$`\\;&|<>()]*))$/;
  for (const s of segs) {
    const m = literal.exec(s);
    if (m) vals.set(m[1], vals.has(m[1]) ? null : (m[2] ?? m[3] ?? m[4] ?? ""));
  }
  if (segs.some((s) => /^(?:source|\.|eval)(?:\s|$)/.test(s))) return new Map();
  const out = new Map<string, string>();
  for (const [name, v] of vals) {
    const bare = new RegExp(`(?:^|[^$\\w{])${name}(?!\\w)`);
    if (v !== null && !segs.some((s) => !literal.test(s) && bare.test(s))) out.set(name, v);
  }
  return out;
}

/** `$NAME` and `${NAME}` replaced by the literal values `literalVars` found; anything else is left as written. */
export function expandVars(seg: string, vars: Map<string, string>): string {
  if (!vars.size) return seg;
  return seg.replace(/\$\{(\w+)\}|\$([A-Za-z_]\w*)/g, (all, a, b) => vars.get(a ?? b) ?? all);
}

// `-c` overrides a covered push may carry: GitHub CLI as the credential helper (with no SSH key loaded, Heartbeat
// sessions push over HTTPS with `-c credential.helper= -c credential.helper='!gh auth git-credential'`: 28 asks,
// 3–4 Nov), the empty value that clears other helpers, and the commit identity. Any other key could run a program.
const SAFE_CONFIG = /^(?:credential(?:\.https:\/\/github\.com)?\.helper=(?:!(?:\/[\w.\/-]*\/)?gh auth git-credential)?|user\.(?:name|email)=[^\n]*)$/;

/** The git global options before the subcommand that a covered command may use, with their values. */
export function gitGlobalsOk(globals: string[]): boolean {
  for (let i = 0; i < globals.length; i++) {
    const g = globals[i];
    if (g === "-C") { i++; continue; }
    if (g === "-c") { if (!SAFE_CONFIG.test(globals[++i] ?? "")) return false; continue; }
    if (!/^(?:--no-pager|-P|--no-optional-locks)$/.test(g)) return false;
  }
  return true;
}

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
  const w = withoutRedirects(shellWords(unwrapTimeout(segment)));
  const at = w.findIndex((x, i) => x === "push" && w[0] === "git" && w.slice(1, i).every((y, j, a) => y.startsWith("-") || /^-[Cc]$/.test(a[j - 1] ?? "")));
  if (at < 0) return "a push the guard can't read";
  if (!gitGlobalsOk(w.slice(1, at))) return "push with `-c` config overrides or other global options";
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

/** How a reviewing session reports engineering:code-review: the skill's own output, never a summary of it. */
export const SHOW_REVIEW = "show its output in your reply as the skill writes it: the Summary, the Critical Issues and Suggestions tables (# | File | Line columns, with each finding's status: fixed in <sha>, open, or listed in the PR), What Looks Good and the Verdict. Never a prose summary instead of the tables.";

/** The merge rules by risk level that `autonomy.merge` sets. */
export function mergeRules(p: Autonomy): string {
  const medium = p.merge.medium === "decide"
    ? "your call, one of three: merge on green when the review is ok and the evidence shows the feature working; block it (don't merge; fix it, or say why it can't merge) when the review found Critical or High issues or the change isn't right yet; or ask the user, with evidence that the feature works and why it should merge"
    : p.merge.medium === "green" ? "merge on green" : "ask the user, with evidence";
  return `low: ${p.merge.low === "green" ? "merge on green" : "ask the user"}. medium: ${medium}. breaking: never merge it yourself; wait for the user's review and approval, and always give evidence that the feature works. Never merge on red CI or with --admin.`;
}

/** How to merge on green without waiting in the session or asking: merge now, or let GitHub merge the reviewed head. */
export function mergeOnGreen(p: Autonomy, n: number | string = "<n>"): string {
  return `Merge on green: CI green → \`gh pr merge ${n} --${p.merge.method} --match-head-commit <head>\`; CI still running on a base that requires checks → the same with \`--auto\` (GitHub merges that head once the checks pass; the policy is the user's request for this auto-merge); CI red → fix it on the branch, or say whose it is. Never end a turn asking to merge once CI is green.`;
}

/**
 * The brief for a PR's review session (`"review": "session"`): review, show the tables, fix, rate, merge or stop.
 * `mainCheckout` is where the shared checkout lives; the session fixes things in its own detached worktree.
 */
export function reviewBrief(o: { n: number; url: string; base: string; policy: Autonomy; riskScript: string; cleanupScript: string; mainCheckout: string }): string {
  const { n, url, base, policy: p } = o;
  const merges = p.merge.low !== "ask" || p.merge.medium !== "ask";
  return [
    `Review session for PR #${n} (${url}), against ${base}. The user asked for a review session per pull request (autonomy.review "session" in .claude/delivery.json): you review the PR, fix what the review confirms, rate it and ${merges ? "merge it or stop" : "report"} by the delivery policy's risk rules. You own it until it merges or needs the user.`,
    `1. Review it with the engineering:code-review skill, and ${SHOW_REVIEW}`,
    `2. Fix the Critical and High findings, and the Medium ones you confirm, in a detached worktree; the checkout at ${o.mainCheckout} is shared with other sessions, so never switch its branch or edit files there: \`gh pr view ${n} --json headRefName\`, \`git fetch origin <branch>\`, \`git worktree add --detach .claude/worktrees/pr-${n}-review origin/<branch>\`. Commit per CONTRIBUTING.md (Conventional Commits), run the checks for what changed, and \`git push origin HEAD:<branch>\` (if the branch moved, rebase onto it first; never force-push). List what you leave (Low, or needing a design decision) in the PR description.`,
    `3. Rate it: \`bun "${o.riskScript}" -C ${o.mainCheckout} --pr ${n} --review <verdict> --format md\` (blocking: a Critical or High finding left; fix: a Medium one left; ok: Low or none), and put its Decision block under the review tables.`,
    merges
      ? `4. Do what its Next line says. ${mergeRules(p)} ${mergeOnGreen(p, n)}`
      : "4. Merging isn't in the policy: give the user the Decision block and the evidence, and stop.",
    `5. Then remove the review worktree${p.cleanupMerged ? ` and, after a merge, run \`bun "${o.cleanupScript}" -C ${o.mainCheckout}\`` : ""}. Reply with the review tables, the Decision block and what you did (merged as <sha>, auto-merge set on <head>, blocked because…, or the ask with its evidence).`,
    "If the PR gets new commits after your review (a CI fix, a conflict), review those, re-rate it and redo step 4.",
  ].join("\n");
}

/**
 * What the session that opened PR `n` is told when it already ran engineering:code-review on the change: it is the
 * reviewer, so it owns the merge and no review session starts (Heartbeat PR 135, 7 Nov 2026: a second review card
 * for a PR this session had reviewed and rated).
 */
export function reviewedHere(o: { n: number; url: string; policy: Autonomy; riskScript: string; mainCheckout: string }): string {
  const merges = o.policy.merge.low !== "ask" || o.policy.merge.medium !== "ask";
  return [
    `Pull request opened: ${o.url}. This session already reviewed this change with engineering:code-review, so it owns PR #${o.n}: don't start a review session for it.`,
    `Rate it on its current head: \`bun "${o.riskScript}" -C ${o.mainCheckout} --pr ${o.n} --review ok|fix|blocking --format md\` and put its Decision block under the review tables${merges ? `, then do what its Next line says. ${mergeOnGreen(o.policy, o.n)}` : "; merging isn't in the policy, so give the user the Decision block and stop."}`,
    "Commits added after the review need a review of their own before the merge.",
  ].join("\n");
}

/** What the session that opened PR `n` is told to do when the policy reviews PRs in their own session. */
export function reviewSessionStart(o: Parameters<typeof reviewBrief>[0]): string {
  const brief = reviewBrief(o);
  return [
    `Pull request opened: ${o.url}. Delivery autonomy ("review": "session" in .claude/delivery.json): every PR gets its own review session, which reviews it, fixes what it confirms and merges or stops by the risk rules. Start it now, and don't review this PR here:`,
    `mcp__ccd_session__start_session with initiation "user_asked" (the user asked for this session for every PR), use_worktree false, context "fresh", title "Code review: PR #${o.n}", name "review-pr-${o.n}"${o.policy.reviewPreset ? `, preset "${o.policy.reviewPreset}"` : ""};`,
    `background: ${JSON.stringify(brief)};`,
    `prompt: "Review ${o.url} with the engineering:code-review skill and show its tables, fix what it confirms, then rate it with pr_risk.ts and merge or stop by the delivery merge rules."`,
    "If the app refuses to start it on this turn, propose the same session with initiation \"own_initiative\". Without a start_session tool (the CLI), follow the brief here instead.",
    "Then carry on with your work: the review session owns this PR's merge, so don't wait for it or ask the user about merging it.",
  ].join("\n");
}

/**
 * Standing-authorization text added to the session context when the policy is on.
 * `cleanupScript` is the absolute path of cleanup_merged.ts; without it the cleanup steps are spelled out.
 * `riskScript` is the absolute path of pr_risk.ts, used by the merge rules.
 */
export function policyContext(p: Autonomy, base: string, cleanupScript?: string, riskScript = "pr_risk.ts"): string {
  const lines = [
    "Delivery autonomy: the user approved this policy in .claude/delivery.json. It is standing authorization; don't ask again for these steps.",
    "- It is the durable, explicit authorization that rules like \"commit or push only when the user asks\", \"offer Auto-fix\", \"ask before acting on what you found\" or \"never enable auto-merge unless the user asked\" wait for: for the steps below, the user has already asked. Never turn a covered step into a question, an end-of-turn button (wrap_up ask), a proposal card or \"want me to…?\": do it, then report what you did. A question at the end of a turn is only for the \"still stop\" list at the bottom.",
    `- Ship without stopping to offer it: when the checks pass, ${p.review === "self" ? `review the change with the \`engineering:code-review\` skill against ${base} (fix Critical and High findings first; list Medium and Low ones in the PR description), then ` : ""}commit (Conventional Commits), push branches matching ${p.push.join(", ")}${p.openPr ? `, and open the pull request against ${base} (follow CONTRIBUTING.md or the PR template)` : ""}, in the same turn. Work on a new feature branch, never directly on ${base}.`,
  ];
  if (p.review === "session") lines.push(`- Each PR gets its own review session: when \`gh pr create\` opens one, a delivery hook tells you how to start it (start_session, title "Code review: PR #<n>"). Don't review that PR in the session that opened it, and don't wait for its merge or ask the user about it: the review session owns it. If this session already reviewed the change before opening the PR, it owns the PR instead: no review session, rate it and merge or stop here.`);
  if (p.review) lines.push(`- Whenever you run \`engineering:code-review\`, ${SHOW_REVIEW}`);
  if (p.autoFix) lines.push("- After opening a PR, turn on PR monitoring / Auto-fix when the host offers it.");
  if (p.cleanupMerged) lines.push(cleanupScript
    ? `- When the user says a PR is merged (or you see it is): run \`bun "${cleanupScript}" -C <main checkout>\` once and relay its lines. It fetches with prune, fast-forwards ${base}, removes the clean worktrees of merged branches and deletes them with \`git branch -d\`; anything unmerged or dirty is kept with the reason. Don't redo these steps by hand.`
    : `- When the user says a PR is merged (or you see it is): \`git fetch --prune\`, update ${base}, remove that branch's worktree and delete its local branch with \`git branch -d\` (never -D).`);
  if (p.continue) lines.push(`- Then continue: start the next item in ${p.continue.backlog} whose dependencies are done (merged), and ship each the same way, until no unblocked item is left. Skip items that need a decision.`);
  if (p.localClusters.length) lines.push(`- kubectl/helm against local clusters (${p.localClusters.join(", ")}) needs no ask.`);
  if (p.workflows.length) lines.push(`- \`gh workflow run\` for ${p.workflows.join(", ")} needs no ask.`);
  const merges = p.merge.low !== "ask" || p.merge.medium !== "ask";
  if (merges) lines.push(
    `- Merging by risk: the session that reviews a PR with \`engineering:code-review\` (including a review session another session started) owns it to the merge: fix Critical and High findings on the PR branch and push, then run \`bun "${riskScript}" -C <repo> --pr <n> --review ok|fix|blocking --format md\` (blocking: any Critical or High finding left; fix: Medium; ok: Low or none), put its Decision block under the review tables, and do what its Next line says. A session that didn't run the review can't merge by policy: hand the PR to its review session instead of asking the user; after pushing to a reviewed PR (a CI fix, a conflict), tell its review session (SendMessage) so it re-checks and merges.`,
    `  It rates the PR low, medium or breaking from the diff. Raise the level when the review shows more risk, never lower it, and when unsure between medium and breaking, treat it as breaking. Medium means decide, not ask: ask only when you have a real doubt you can name.`,
    `  ${mergeRules(p)}`,
    `  ${mergeOnGreen(p)}`,
    "  Evidence faces the product and fits the project: screenshots of the UI, a recording of the feature in use, a live demo of the service (the requests and what comes back), a run on a local cluster, plus well-defined test results (commands, exit codes, counts, which tests cover the feature). The script lists what fits the diff. Summarise it in the PR. An ask is the end-of-turn card and shows the review tables and the Decision block, then the product working with the change, sent as files (SendUserFile: screenshots, a recording, a demo or hook-replay transcript); tests and CI back it up but never stand alone. With several PRs or sessions waiting, ask once for all of them.",
    "  After a merge, clean up (below) and bring the dependent branches up to date with the base before their own review.",
  );
  lines.push(
    `- Still stop and ask, with every open question in one message: merging${merges ? " beyond the risk rules above" : ""} (unless the user's message just asked you to merge that PR), tags, releases, publishing, deploys, pushing to ${base}, force pushes, deleting unmerged work, and any item that needs a decision (an ADR, cost, an open question, missing access or credentials).`,
    "- If the user says to hold, wait or not push, hold. When you are blocked on the user, keep doing the unblocked work and ask once at the end.",
  );
  return lines.join("\n");
}
