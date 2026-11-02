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
 * Opt-out: DELIVERY_STOP_GATE=0, or {"stopGate": false} in .claude/delivery.json.
 * Reviews only: {"stopGate": {"reviews": false}} keeps the quality and secret checks.
 * Exit 0 = allow stop; exit 2 + stderr = block with that message.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight, type Preflight, type Review } from "../skills/delivery-lifecycle/scripts/preflight";
import { asksToHold, globMatch, lastUserPrompt, loadConfig, parseAutonomy, reviewed, skillUsed, toolUses, type Autonomy } from "./autonomy";
import { baseBranch } from "./session_context";

export { asksToHold, lastUserPrompt, reviewed, skillUsed, toolUses };

interface HookInput { session_id?: string; transcript_path?: string; cwd?: string; stop_hook_active?: boolean }
interface State { qualityBlocks: number; reviewBlocks: string[]; shipNudged?: boolean; reviewNudged?: boolean }
type Any = any;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Docs, for the review nudge. Plain `.txt` only under docs/: requirements.txt and CMakeLists.txt are code.
const DOCS = /\.(md|mdx|rst|adoc)$|(^|\/)docs?\/.*\.txt$/i;
export const isDocs = (f: string) => DOCS.test(f);

export function sessionEdited(uses: { name: string; input: Any }[]): boolean {
  return uses.some((u) => EDIT_TOOLS.has(u.name) || (u.name === "Bash" && /\bsed\s+-i\b|\bgit\b[^|;&]*\bcommit\b|\bpatch\b\s+-p|\btee\b|(^|[^0-9&])>\s*[\w./-]+\.\w+/.test(String(u.input.command ?? ""))));
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out.trim() : null;
  } catch { return null; } // the session's cwd was removed (a cleaned-up worktree): not a repository
}

/** Compare a feature branch with its default branch; otherwise look at uncommitted work. */
async function target(cwd: string): Promise<{ base?: string }> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const remoteHead = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd))?.replace(/^origin\//, "");
  for (const d of [remoteHead, "main", "master"].filter(Boolean) as string[]) {
    if (branch && branch !== d && (await git(["rev-parse", "--verify", "--quiet", d], cwd))) return { base: d };
  }
  return {};
}

/** True when the session opened a pull request (gh or a source-control tool). */
export function openedPr(uses: { name: string; input: Any }[]): boolean {
  return uses.some((u) => (u.name === "Bash" && /\bgh\s+pr\s+create\b/.test(String(u.input.command ?? ""))) || /create_pull_request/.test(u.name));
}

/** Checked-out branches of the repository's worktrees (the main checkout first), from `git worktree list --porcelain`. */
async function worktrees(cwd: string): Promise<{ path: string; branch: string | null }[]> {
  const out = (await git(["worktree", "list", "--porcelain"], cwd)) ?? "";
  return out.split("\n\n").map((b) => ({
    path: /^worktree (.+)$/m.exec(b)?.[1] ?? "",
    branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? null,
  })).filter((w) => w.path);
}

/**
 * Why the policy says work should still be shipped, or null when there is nothing to ship. Looks at every
 * worktree, since work often happens in `.claude/worktrees/<branch>` while the session sits in the main checkout.
 */
export async function unshipped(cwd: string, policy: Autonomy, uses: { name: string; input: Any }[]): Promise<string | null> {
  if (!policy.push.length || !(await git(["remote"], cwd))) return null;
  const base = baseBranch(cwd, policy.base);
  const here = await git(["rev-parse", "--show-toplevel"], cwd);
  // Claude's own config (.claude/) is often untracked; it isn't work to ship.
  const dirtyAt = async (dir: string) => ((await git(["status", "--porcelain"], dir)) ?? "").split("\n").some((l) => l.trim() && !/^.. "?\.claude\//.test(l));
  const bash = uses.filter((u) => u.name === "Bash").map((u) => String(u.input.command ?? ""));
  const list = await worktrees(cwd);
  for (const w of list.length ? list : [{ path: here ?? cwd, branch: await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) }]) {
    if (!w.branch) continue;
    const where = w.path === here ? "" : ` (worktree ${w.path})`;
    const dirty = await dirtyAt(w.path);
    if (w.branch === base) {
      if (w.path !== here) continue;
      const ahead = Number((await git(["rev-list", "--count", `origin/${base}..HEAD`], w.path)) ?? 0);
      if (dirty || ahead > 0) return `you changed files on ${base}. Move the work to a new branch matching ${policy.push.join(", ")} (keep ${base} as it was) and ship it from there`;
      continue;
    }
    if (!policy.push.some((g) => globMatch(g, w.branch!))) continue;
    const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], w.path);
    const since = upstream ? "@{u}" : (await git(["rev-parse", "--verify", "--quiet", `origin/${base}`], w.path)) ? `origin/${base}` : base;
    const ahead = Number((await git(["rev-list", "--count", `${since}..HEAD`], w.path)) ?? 0);
    if (dirty || ahead > 0) return `${w.branch}${where} has ${dirty ? "uncommitted changes" : `${ahead} commit(s) not pushed`}. Commit, push it${policy.openPr ? ` and open the pull request against ${base}` : ""}`;
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
async function codeOnBranches(cwd: string, policy: Autonomy): Promise<boolean> {
  const base = baseBranch(cwd, policy.base);
  for (const w of await worktrees(cwd)) {
    if (!w.branch || w.branch === base || !policy.push.some((g) => globMatch(g, w.branch!))) continue;
    const ref = (await git(["rev-parse", "--verify", "--quiet", `origin/${base}`], w.path)) ? `origin/${base}` : base;
    const mb = await git(["merge-base", "HEAD", ref], w.path);
    const files = [...((mb ? await git(["diff", "--name-only", mb], w.path) : null) ?? "").split("\n"), ...((await git(["status", "--porcelain"], w.path)) ?? "").split("\n").map((l) => l.slice(3))];
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
  const uses = haveTranscript ? toolUses(readFileSync(input.transcript_path!, "utf8")) : [];
  if (haveTranscript ? !sessionEdited(uses) : !(await git(["status", "--porcelain"], cwd))) return 0;
  const config = loadConfig(cwd);
  if (config.stopGate === false) return 0;
  const reviewsOn = config.stopGate?.reviews !== false;

  const stateDir = join(tmpdir(), "delivery-stop-gate");
  const statePath = join(stateDir, `${(input.session_id ?? "unknown").replace(/[^\w-]/g, "")}.json`);
  let state: State = { qualityBlocks: 0, reviewBlocks: [] };
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* first stop */ }

  const p = await preflight(cwd, { ...(await target(cwd)), timeoutS: config.preflight?.timeoutSeconds ?? 300 });
  if (typeof p === "string") return 0; // not a reviewable repo state: never block on our own errors
  // Only security blocks at Stop (and only on a risky pattern or a configured path). Migration, performance
  // and CI concerns are deploy/merge questions: shown to the user as a note, enforced at the merge and release gates.
  const reviews = reviewsOn ? p.reviews.filter((r) => r.gate === "security" && r.strong && !skillUsed(uses, r.skill) && !state.reviewBlocks.includes(r.gate)) : [];
  const qualityBlock = !p.ok && state.qualityBlocks < 2;
  if (!qualityBlock && !reviews.length) {
    const notes = p.reviews.filter((r) => !reviews.includes(r) && !skillUsed(uses, r.skill)).map((r) => `${r.gate}: ${r.why} → consider ${r.skill} before merging`);
    const policy = parseAutonomy(config);
    const hold = asksToHold(haveTranscript ? lastUserPrompt(readFileSync(input.transcript_path!, "utf8")) : "");
    const why = policy && p.ok && !state.shipNudged && !hold ? await unshipped(cwd, policy, uses) : null;
    const reviewDue = !!policy?.review && p.ok && !hold && !state.reviewNudged && !reviewed(uses)
      && (p.changed.some((f) => !DOCS.test(f)) || await codeOnBranches(cwd, policy));
    const save = () => { try { mkdirSync(stateDir, { recursive: true }); writeFileSync(statePath, JSON.stringify(state)); } catch { /* best effort */ } };
    const forPr = notes.length ? `\nNotes for the PR description: ${notes.join("; ")}` : "";
    if (why && policy) {
      state.shipNudged = true;
      if (reviewDue) state.reviewNudged = true;
      save();
      process.stderr.write(shipMessage(why, policy, reviewDue ? baseBranch(cwd, policy.base) : undefined) + forPr + "\n");
      return 2;
    }
    if (policy && reviewDue && openedPr(uses)) {
      state.reviewNudged = true;
      save();
      process.stderr.write(reviewMessage(baseBranch(cwd, policy.base)) + forPr + "\n");
      return 2;
    }
    if (notes.length) console.log(JSON.stringify({ systemMessage: `Delivery notes (not blocking): ${notes.join("; ")}` }));
    return 0;
  }

  if (qualityBlock) state.qualityBlocks++;
  state.reviewBlocks.push(...reviews.map((r) => r.gate));
  try { mkdirSync(stateDir, { recursive: true }); writeFileSync(statePath, JSON.stringify(state)); } catch { /* state is best effort */ }
  process.stderr.write(message(qualityBlock ? p : { ...p, blocking: [], quality: [] }, reviews, state.qualityBlocks + state.reviewBlocks.length) + "\n");
  return 2;
}

if (import.meta.main) process.exit(await main());
