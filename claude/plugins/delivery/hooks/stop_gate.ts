#!/usr/bin/env bun
/**
 * Stop hook: when Claude is about to finish a turn in which it edited files, run
 * preflight on the change. If a quality command fails, a secret is in the diff,
 * or the diff has a risky security pattern that hasn't been reviewed in this session,
 * block the stop once with a short reason so Claude fixes it. Performance, migration
 * and CI concerns are shown to the user as a non-blocking note (zero tokens).
 *
 * Costs nothing when the session made no edits (it only reads the transcript;
 * without a transcript it falls back to checking whether the work tree has changes).
 * Limits: at most 2 quality/secret blocks per session, and each review gate
 * blocks at most once, so Claude can explain instead of looping.
 *
 * v3, with an `autonomy` policy in .claude/delivery.json: when the checks pass but the branch has
 * work that isn't pushed (or was pushed without a PR), block once more and tell Claude to ship it per
 * the policy, unless the user's last message asked to hold. Edits made on the base branch get told to
 * move to a feature branch. Never more than once per session.
 *
 * v3.2: shipping includes review. The ship nudge asks for `engineering:code-review` first when the session
 * hasn't run it (itself or in a subagent); a session that opened a PR with code changes and no review
 * gets one nudge to review it. Docs-only changes, `"review": false` and a hold skip both.
 *
 * v3.3: a turn that ran engineering:code-review must show its output (the findings tables), not a summary:
 * one block per review that no reply shows. With `"review": "session"` the session that opens a PR doesn't
 * review it; it gets one nudge to start the PR's review session if it didn't. The ship check only looks at
 * worktrees this session worked in, and asks the remote when a branch was pushed without a tracking ref.
 *
 * Opt-out: DELIVERY_STOP_GATE=0, or {"stopGate": false} in .claude/delivery.json.
 * Reviews only: {"stopGate": {"reviews": false}} keeps the quality and secret checks.
 * Exit 0 = allow stop; exit 2 + stderr = block with that message.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { memoGit, type Git } from "../skills/delivery-lifecycle/scripts/classify_change";
import { preflight, type Preflight, type QualityCache, type QualityResult, type Review } from "../skills/delivery-lifecycle/scripts/preflight";
import { assistantEntries, asksToHold, globMatch, lastUserPrompt, loadConfig, parseAutonomy, realPath, reviewed, SHOW_REVIEW, skillUsed, toolUses, unshownReviews, type Autonomy, type ToolUse } from "./autonomy";
import { repoKey } from "./bash_guard";
import { baseBranch } from "./session_context";

export { asksToHold, lastUserPrompt, reviewed, skillUsed, toolUses };

interface HookInput { session_id?: string; transcript_path?: string; cwd?: string; stop_hook_active?: boolean }
interface State { qualityBlocks: number; reviewBlocks: string[]; shipNudged?: boolean; reviewNudged?: boolean; tablesShown?: string[]; quality?: Record<string, QualityResult> }
type Any = any;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Docs, for the review nudge. Plain `.txt` only under docs/: requirements.txt and CMakeLists.txt are code.
const DOCS = /\.(md|mdx|rst|adoc)$|(^|\/)docs?\/.*\.txt$/i;
export const isDocs = (f: string) => DOCS.test(f);

export function sessionEdited(uses: ToolUse[]): boolean {
  return uses.some((u) => EDIT_TOOLS.has(u.name) || (u.name === "Bash" && /\bsed\s+-i\b|\bgit\b[^|;&]*\bcommit\b|\bpatch\b\s+-p|\btee\b|(^|[^0-9&])>\s*[\w./-]+\.\w+/.test(String(u.input.command ?? ""))));
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out.trim() : null;
  } catch { return null; } // the session's cwd was removed (a cleaned-up worktree): not a repository
}

type TrimGit = (args: string[], cwd: string) => Promise<string | null>;
const trimmed = (g: Git): TrimGit => async (args, cwd) => (await g(args, cwd))?.trim() ?? null;
/** `git` (trimmed output) run once per (cwd, args). */
const memoTrimmed = (): TrimGit => memoGit(git as Git) as TrimGit;
const ORIGIN_HEAD = ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"];

/** Compare a feature branch with its default branch; otherwise look at uncommitted work. */
async function target(cwd: string, g: TrimGit = trimmed(memoGit())): Promise<{ base?: string }> {
  // Asked together; "main" is the usual answer, so its check starts now (`g` runs it once).
  const [branch, originHead] = await Promise.all([g(["rev-parse", "--abbrev-ref", "HEAD"], cwd), g(ORIGIN_HEAD, cwd), g(["rev-parse", "--verify", "--quiet", "main"], cwd)]);
  const remoteHead = originHead?.replace(/^origin\//, "");
  for (const d of [remoteHead, "main", "master"].filter(Boolean) as string[]) {
    if (branch && branch !== d && (await g(["rev-parse", "--verify", "--quiet", d], cwd))) return { base: d };
  }
  return {};
}

/**
 * session_context's baseBranch, with the origin/HEAD lookup `target` already made answered by `g` (the usual case).
 * Without an origin/HEAD, baseBranch itself picks main or master.
 */
async function baseOf(cwd: string, configured: string | null, g: TrimGit): Promise<string> {
  if (configured) return configured;
  return (await g(ORIGIN_HEAD, cwd))?.replace(/^origin\//, "") || baseBranch(cwd, null);
}

/** True when the session opened a pull request (gh or a source-control tool). */
export function openedPr(uses: ToolUse[]): boolean {
  return uses.some((u) => (u.name === "Bash" && /\bgh\s+pr\s+create\b/.test(String(u.input.command ?? ""))) || /create_pull_request/.test(u.name));
}

/** True when the session started (or proposed) a PR's review session. */
export function startedReviewSession(uses: ToolUse[]): boolean {
  return uses.some((u) => /start_session$/.test(u.name) && /^Code review: PR #\d+$/.test(String(u.input.title ?? "")));
}

/**
 * Directories this session worked in: files it edited, directories it `cd`'d into or ran `git -C` on, and its own
 * directory when it committed or wrote files there. The ship check only looks at worktrees holding one of these,
 * so a review session in the shared checkout isn't told to ship another session's branch (Heartbeat, 4 Nov).
 */
export function touchedDirs(uses: ToolUse[], cwd: string): string[] {
  const out: string[] = [];
  const unq = (p: string) => p.replace(/^["']|["']$/g, "");
  for (const u of uses) {
    const f = u.input?.file_path ?? u.input?.notebook_path;
    if (EDIT_TOOLS.has(u.name) && typeof f === "string") out.push(resolve(cwd, f));
    if (u.name !== "Bash") continue;
    const c = String(u.input.command ?? "");
    const moves = [...c.matchAll(/(?:^|[;&|(\s])cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g), ...c.matchAll(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/g)];
    for (const m of moves) if (!/[$`~]/.test(m[1])) out.push(resolve(cwd, unq(m[1])));
    if (!moves.length && sessionEdited([u])) out.push(cwd);
  }
  return out;
}

/** The worktree (most specific path) each touched directory belongs to. */
function owners(dirs: string[], trees: { path: string }[]): Set<string> {
  const byLength = [...trees].map((t) => ({ path: t.path, at: realPath(t.path) })).sort((a, b) => b.at.length - a.at.length);
  const out = new Set<string>();
  for (const d of dirs.map(realPath)) {
    const w = byLength.find((t) => d === t.at || d.startsWith(t.at + "/"));
    if (w) out.add(w.path);
  }
  return out;
}

/** Checked-out branches of the repository's worktrees (the main checkout first), from `git worktree list --porcelain`. */
async function worktrees(cwd: string, g: TrimGit = git): Promise<{ path: string; branch: string | null }[]> {
  const out = (await g(["worktree", "list", "--porcelain"], cwd)) ?? "";
  return out.split("\n\n").map((b) => ({
    path: /^worktree (.+)$/m.exec(b)?.[1] ?? "",
    branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? null,
  })).filter((w) => w.path);
}

/**
 * The commit `branch` points to on the remote, null when the remote doesn't have it, or "unknown" when it can't be
 * read in time (no SSH key, offline). GitHub repositories are read with `gh api`, whose login works when SSH doesn't.
 */
async function remoteHead(dir: string, branch: string, git: TrimGit): Promise<string | null | "unknown"> {
  const read = async (cmd: string[]) => {
    try {
      const p = Bun.spawn(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      const timer = setTimeout(() => p.kill(), 5_000);
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      clearTimeout(timer);
      return { out: out.trim(), err, code };
    } catch { return null; }
  };
  const key = repoKey((await git(["remote", "get-url", "origin"], dir)) ?? "");
  if (key?.startsWith("github.com/")) {
    const r = await read(["gh", "api", `repos/${key.slice(11)}/git/ref/heads/${branch}`, "--jq", ".object.sha"]);
    if (r?.code === 0 && /^[0-9a-f]{40}$/.test(r.out)) return (await git(["cat-file", "-e", `${r.out}^{commit}`], dir)) !== null ? r.out : "unknown";
    if (r && /HTTP 404/.test(r.err)) return null;
    return "unknown";
  }
  const r = await read(["git", "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);
  if (r?.code === 0) { const sha = r.out.split(/\s/)[0]; return (await git(["cat-file", "-e", `${sha}^{commit}`], dir)) !== null ? sha : "unknown"; }
  return r?.code === 2 ? null : "unknown";
}

/**
 * Why the policy says work should still be shipped, or null when there is nothing to ship. Looks at every
 * worktree, since work often happens in `.claude/worktrees/<branch>` while the session sits in the main checkout.
 */
export async function unshipped(cwd: string, policy: Autonomy, uses: ToolUse[], run: TrimGit = memoTrimmed()): Promise<string | null> {
  if (!policy.push.length) return null;
  // Independent lookups, asked together (only `remote` decides whether the rest is used).
  const [remotes, here, list] = await Promise.all([run(["remote"], cwd), run(["rev-parse", "--show-toplevel"], cwd), worktrees(cwd, run)]);
  if (!remotes) return null;
  const base = await baseOf(cwd, policy.base, run);
  // Claude's own config (.claude/) is often untracked; it isn't work to ship.
  const dirtyAt = async (dir: string) => ((await run(["status", "--porcelain"], dir)) ?? "").split("\n").some((l) => l.trim() && !/^.. "?\.claude\//.test(l));
  const bash = uses.filter((u) => u.name === "Bash").map((u) => String(u.input.command ?? ""));
  const trees = list.length ? list : [{ path: here ?? cwd, branch: await run(["rev-parse", "--abbrev-ref", "HEAD"], cwd) }];
  const mine = owners(touchedDirs(uses, cwd), trees);
  for (const w of trees) {
    if (!w.branch || !mine.has(w.path)) continue;
    const where = w.path === here ? "" : ` (worktree ${w.path})`;
    if (w.branch === base) {
      if (w.path !== here) continue;
      const [dirty, aheadOut] = await Promise.all([dirtyAt(w.path), run(["rev-list", "--count", `origin/${base}..HEAD`], w.path)]);
      const ahead = Number(aheadOut ?? 0);
      if (dirty || ahead > 0) return `you changed files on ${base}. Move the work to a new branch matching ${policy.push.join(", ")} (keep ${base} as it was) and ship it from there`;
      continue;
    }
    if (!policy.push.some((g) => globMatch(g, w.branch!))) continue;
    // The tracking-ref check is only read without an upstream, and the origin URL only when the remote is asked,
    // but both are cheap local reads: start them with the rest instead of after.
    const [dirty, upstream, originRef] = await Promise.all([
      dirtyAt(w.path),
      run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], w.path),
      run(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${w.branch}`], w.path),
      run(["remote", "get-url", "origin"], w.path),
    ]);
    const tracking = upstream ? "@{u}" : originRef ? `origin/${w.branch}` : null;
    const count = async (since: string) => Number((await run(["rev-list", "--count", `${since}..HEAD`], w.path)) ?? 0);
    let ahead = tracking ? await count(tracking) : null;
    if (ahead === null || ahead > 0) {
      // A push to a URL (`git push https://… feature/x`) leaves the tracking ref missing or stale: ask the remote
      // before nudging, and keep the local answer only when the remote can't say.
      const [remote, originBase] = await Promise.all([remoteHead(w.path, w.branch, run), run(["rev-parse", "--verify", "--quiet", `origin/${base}`], w.path)]);
      if (remote === "unknown") { if (ahead === null) continue; }
      else ahead = await count(remote ?? (originBase ? `origin/${base}` : base));
    }
    if (dirty || (ahead ?? 0) > 0) return `${w.branch}${where} has ${dirty ? "uncommitted changes" : `${ahead} commit(s) not pushed`}. Commit, push it${policy.openPr ? ` and open the pull request against ${base}` : ""}`;
    if (policy.openPr && upstream && bash.some((b) => /\bgit\b[^;&|]*\bpush\b/.test(b)) && !bash.some((b) => /\bgh\s+pr\s+(create|view|list)\b/.test(b)))
      return `${w.branch}${where} is pushed but no pull request was opened. Open it against ${base}`;
  }
  return null;
}

const reviewStep = (base: string) => `review the branch with the \`engineering:code-review\` skill against ${base}: fix Critical and High findings before pushing and list Medium and Low ones in the PR description`;

/** `reviewAgainst`: the base branch, when the change still needs its review before it ships. */
/**
 * True when a feature branch the policy ships (in any worktree) changes more than docs against the base, so a
 * session that sits in the main checkout and works in `.claude/worktrees/<branch>` still gets the review step.
 */
async function codeOnBranches(cwd: string, policy: Autonomy, uses: ToolUse[], run: TrimGit = memoTrimmed()): Promise<boolean> {
  const [base, trees] = await Promise.all([baseOf(cwd, policy.base, run), worktrees(cwd, run)]);
  const mine = owners(touchedDirs(uses, cwd), trees);
  for (const w of trees) {
    if (!w.branch || w.branch === base || !mine.has(w.path) || !policy.push.some((g) => globMatch(g, w.branch!))) continue;
    const [originBase, status] = await Promise.all([run(["rev-parse", "--verify", "--quiet", `origin/${base}`], w.path), run(["status", "--porcelain"], w.path)]);
    const ref = originBase ? `origin/${base}` : base;
    const mb = await run(["merge-base", "HEAD", ref], w.path);
    const files = [...((mb ? await run(["diff", "--name-only", mb], w.path) : null) ?? "").split("\n"), ...(status ?? "").split("\n").map((l) => l.slice(3))];
    if (files.some((f) => f.trim() && !DOCS.test(f) && !f.startsWith(".claude/"))) return true;
  }
  return false;
}

export function shipMessage(why: string, policy: Autonomy, reviewAgainst?: string): string {
  return [
    `Delivery autonomy (.claude/delivery.json, approved by the user): the checks pass, but ${why}.`,
    `Do it now without asking${reviewAgainst ? ` (first ${reviewStep(reviewAgainst)})` : ""}${policy.continue ? `, then continue with the next unblocked item in ${policy.continue.backlog}` : ""}.`,
    "Stop instead only if the user asked you to hold or something needs their decision; then say so in one line. This won't block again.",
  ].join(" ");
}

export function reviewSessionMessage(): string {
  return [
    "Delivery autonomy (.claude/delivery.json, \"review\": \"session\"): this session opened a pull request, and its review session wasn't started.",
    "Start it now as the hook described when the PR opened (start_session, title \"Code review: PR #<n>\"); without that tool, review it here with `engineering:code-review`.",
    "Stop instead only if the user asked you to hold; then say so in one line. This won't block again.",
  ].join(" ");
}

export function tableMessage(): string {
  return [
    "Show the review: `engineering:code-review` ran, but no reply shows its result. The user wants the skill's tables, not a summary:",
    `${SHOW_REVIEW.charAt(0).toUpperCase()}${SHOW_REVIEW.slice(1)}`,
    "If you rated the PR, put pr_risk.ts's Decision block (`--format md`) under the tables. This won't block again for this review.",
  ].join(" ");
}

export function reviewMessage(base: string): string {
  return [
    "Delivery autonomy (.claude/delivery.json): this session opened a pull request with code changes and no review.",
    `Now ${reviewStep(base)}, and push the fixes to the same branch.`,
    "Stop instead only if the user asked you to hold; then say so in one line. This won't block again.",
  ].join(" ");
}

export function message(p: Preflight, reviews: Review[], attempt: number): string {
  const lines = [`Delivery check before finishing (automatic, ${attempt}):`];
  for (const b of p.blocking) lines.push(`- ✗ ${b}`);
  for (const q of p.quality.filter((x) => !x.passed)) lines.push(`  output tail:\n${q.output_tail.split("\n").slice(-8).map((l) => "    " + l).join("\n")}`);
  for (const r of reviews) lines.push(`- Review needed (${r.gate}): ${r.why}. Run the \`${r.skill}\` skill on this change and address what it finds, or tell the user why you can't. This gate won't block again.`);
  if (p.advisories.length) lines.push(`- Note: ${p.advisories.join("; ")}`);
  lines.push("Fix the failures above before finishing, or say clearly in your reply why they can't be fixed now.");
  return lines.join("\n");
}

export async function main(): Promise<number> {
  if (process.env.DELIVERY_STOP_GATE === "0") return 0;
  let input: HookInput;
  try { input = JSON.parse(await Bun.stdin.text()); } catch { return 0; }
  const cwd = input.cwd ?? process.cwd();
  if (!(await git(["rev-parse", "--is-inside-work-tree"], cwd))) return 0;
  // Normal sessions have a transcript; without one (e.g. no session persistence) fall back to "the tree has changes".
  const haveTranscript = !!input.transcript_path && existsSync(input.transcript_path);
  const transcript = haveTranscript ? readFileSync(input.transcript_path!, "utf8") : "";
  const entries = assistantEntries(transcript);
  const uses: ToolUse[] = entries.flatMap((e) => (e.kind === "use" ? [e] : []));
  const config = loadConfig(cwd);
  if (config.stopGate === false) return 0;
  const reviewsOn = config.stopGate?.reviews !== false;

  const stateDir = join(tmpdir(), "delivery-stop-gate");
  const statePath = join(stateDir, `${(input.session_id ?? "unknown").replace(/[^\w-]/g, "")}.json`);
  let state: State = { qualityBlocks: 0, reviewBlocks: [] };
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* first stop */ }
  const saveState = () => { try { mkdirSync(stateDir, { recursive: true }); writeFileSync(statePath, JSON.stringify(state)); } catch { /* best effort */ } };

  // A review whose tables no reply shows: once per review, edits or not (a clean review edits nothing).
  const unshown = unshownReviews(entries).filter((k) => !(state.tablesShown ?? []).includes(k));
  if (unshown.length) {
    state.tablesShown = [...(state.tablesShown ?? []), ...unshown];
    saveState();
    process.stderr.write(tableMessage() + "\n");
    return 2;
  }
  if (haveTranscript ? !sessionEdited(uses) : !(await git(["status", "--porcelain"], cwd))) return 0;

  // One git runner for the check: target, classify and preflight share its lookups (toplevel, refs, untracked
  // files). The toplevel classify needs first is asked for alongside target's lookups.
  const pre = memoGit();
  const [t] = await Promise.all([target(cwd, trimmed(pre)), pre(["rev-parse", "--show-toplevel"], cwd)]);
  // Every stop after the session's first edit runs the check again, often on files it already checked (a reply,
  // a commit of checked work): reuse the quality results for the same files. Only the latest files' results are kept.
  let cacheChanged = false;
  const cache: QualityCache = {
    get: (key) => state.quality?.[key],
    set: (key, result) => {
      const files = key.slice(0, key.indexOf("\0") + 1);
      state.quality = { ...Object.fromEntries(Object.entries(state.quality ?? {}).filter(([k]) => k.startsWith(files))), [key]: result };
      cacheChanged = true;
    },
  };
  const p = await preflight(cwd, { ...t, timeoutS: config.preflight?.timeoutSeconds ?? 300, git: pre, cache });
  if (cacheChanged) saveState();
  if (typeof p === "string") return 0; // not a reviewable repo state: never block on our own errors
  // After the quality commands ran (they may write files), only the toplevel and origin/HEAD are reused.
  const reuse = new Set(["rev-parse --show-toplevel", ORIGIN_HEAD.join(" ")]);
  const post = memoGit(((args, dir) => (reuse.has(args.join(" ")) ? trimmed(pre) : git)(args, dir!)) as Git) as TrimGit;
  // Only security blocks at Stop (and only on a risky pattern or a configured path). Migration, performance
  // and CI concerns are deploy/merge questions: shown to the user as a note, enforced at the merge and release gates.
  const reviews = reviewsOn ? p.reviews.filter((r) => r.gate === "security" && r.strong && !skillUsed(uses, r.skill) && !state.reviewBlocks.includes(r.gate)) : [];
  const qualityBlock = !p.ok && state.qualityBlocks < 2;
  if (!qualityBlock && !reviews.length) {
    const notes = p.reviews.filter((r) => !reviews.includes(r) && !skillUsed(uses, r.skill)).map((r) => `${r.gate}: ${r.why} → consider ${r.skill} before merging`);
    const policy = parseAutonomy(config);
    const hold = asksToHold(lastUserPrompt(transcript));
    const why = policy && p.ok && !state.shipNudged && !hold ? await unshipped(cwd, policy, uses, post) : null;
    // "session": the PR's review session reviews it after it opens, so nothing is reviewed before pushing.
    const reviewDue = !!policy?.review && p.ok && !hold && !state.reviewNudged && !reviewed(uses)
      && (p.changed.some((f) => !DOCS.test(f)) || await codeOnBranches(cwd, policy, uses, post));
    const save = saveState;
    const forPr = notes.length ? `\nNotes for the PR description: ${notes.join("; ")}` : "";
    if (why && policy) {
      state.shipNudged = true;
      const reviewFirst = reviewDue && policy.review === "self";
      if (reviewFirst) state.reviewNudged = true;
      save();
      process.stderr.write(shipMessage(why, policy, reviewFirst ? await baseOf(cwd, policy.base, post) : undefined) + forPr + "\n");
      return 2;
    }
    if (policy && reviewDue && openedPr(uses) && !(policy.review === "session" && startedReviewSession(uses))) {
      state.reviewNudged = true;
      save();
      process.stderr.write((policy.review === "session" ? reviewSessionMessage() : reviewMessage(await baseOf(cwd, policy.base, post))) + forPr + "\n");
      return 2;
    }
    if (notes.length) console.log(JSON.stringify({ systemMessage: `Delivery notes (not blocking): ${notes.join("; ")}` }));
    return 0;
  }

  if (qualityBlock) state.qualityBlocks++;
  state.reviewBlocks.push(...reviews.map((r) => r.gate));
  saveState();
  process.stderr.write(message(qualityBlock ? p : { ...p, blocking: [], quality: [] }, reviews, state.qualityBlocks + state.reviewBlocks.length) + "\n");
  return 2;
}

if (import.meta.main) process.exit(await main());
