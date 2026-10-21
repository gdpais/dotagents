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
 * Opt-out: DELIVERY_STOP_GATE=0, or {"stopGate": false} in .claude/delivery.json.
 * Reviews only: {"stopGate": {"reviews": false}} keeps the quality and secret checks.
 * Exit 0 = allow stop; exit 2 + stderr = block with that message.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight, type Preflight, type Review } from "../skills/delivery-lifecycle/scripts/preflight";
import { globMatch, loadConfig, parseAutonomy, type Autonomy } from "./autonomy";
import { baseBranch } from "./session_context";

interface HookInput { session_id?: string; transcript_path?: string; cwd?: string; stop_hook_active?: boolean }
interface State { qualityBlocks: number; reviewBlocks: string[]; shipNudged?: boolean }
type Any = any;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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

export function sessionEdited(uses: { name: string; input: Any }[]): boolean {
  return uses.some((u) => EDIT_TOOLS.has(u.name) || (u.name === "Bash" && /\bsed\s+-i\b|\bgit\b[^|;&]*\bcommit\b|\bpatch\b\s+-p|\btee\b|(^|[^0-9&])>\s*[\w./-]+\.\w+/.test(String(u.input.command ?? ""))));
}

/** True when the session loaded the skill (Skill tool, possibly plugin-namespaced) or read its SKILL.md. */
export function skillUsed(uses: { name: string; input: Any }[], skill: string): boolean {
  const bare = skill.split(":").pop()!;
  return uses.some((u) =>
    (u.name === "Skill" && (String(u.input.skill ?? "") === skill || String(u.input.skill ?? "").split(":").pop() === bare)) ||
    (u.name === "Read" && String(u.input.file_path ?? "").endsWith(`/${bare}/SKILL.md`)));
}

async function git(args: string[], cwd: string): Promise<string | null> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out.trim() : null;
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

/** The text of the last prompt the user typed (not tool results or hook feedback). */
export function lastUserPrompt(transcript: string): string {
  let last = "";
  for (const line of transcript.split("\n")) {
    if (!line.includes('"user"')) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type !== "user" || e.isMeta) continue;
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

export function shipMessage(why: string, policy: Autonomy): string {
  return [
    `Delivery autonomy (.claude/delivery.json, approved by the user): the checks pass, but ${why}.`,
    `Do it now without asking${policy.continue ? `, then continue with the next unblocked item in ${policy.continue.backlog}` : ""}.`,
    "Stop instead only if the user asked you to hold or something needs their decision; then say so in one line. This won't block again.",
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
    const why = policy && p.ok && !state.shipNudged && !asksToHold(haveTranscript ? lastUserPrompt(readFileSync(input.transcript_path!, "utf8")) : "")
      ? await unshipped(cwd, policy, uses) : null;
    if (why && policy) {
      state.shipNudged = true;
      try { mkdirSync(stateDir, { recursive: true }); writeFileSync(statePath, JSON.stringify(state)); } catch { /* best effort */ }
      process.stderr.write(shipMessage(why, policy) + (notes.length ? `\nNotes for the PR description: ${notes.join("; ")}` : "") + "\n");
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
