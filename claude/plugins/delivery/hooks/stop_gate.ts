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
 * Opt-out: DELIVERY_STOP_GATE=0, or {"stopGate": false} in .claude/delivery.json.
 * Reviews only: {"stopGate": {"reviews": false}} keeps the quality and secret checks.
 * Exit 0 = allow stop; exit 2 + stderr = block with that message.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight, type Preflight, type Review } from "../skills/delivery-lifecycle/scripts/preflight";

interface HookInput { session_id?: string; transcript_path?: string; cwd?: string; stop_hook_active?: boolean }
interface State { qualityBlocks: number; reviewBlocks: string[] }
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

function loadConfig(cwd: string): Any {
  for (let dir = cwd; dir && dir !== "/"; dir = join(dir, "..")) {
    const p = join(dir, ".claude", "delivery.json");
    if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } }
    if (existsSync(join(dir, ".git"))) break;
  }
  return {};
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
